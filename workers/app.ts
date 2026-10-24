// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { loginQueryError, renderLoginPage } from "./lib/login-page";
import {
	ACCESS_TOKEN_COOKIE,
	REFRESH_TOKEN_COOKIE,
	extractAccessToken,
	isOwnerEmail,
	isScribaseAuthConfigured,
	refreshSession,
	signInWithPassword,
	signOut,
	verifyOwnerToken,
	ScribaseSignInError,
	type ScribaseAuthConfig,
} from "./lib/scribase-auth";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

/** Access-token cookie Max-Age floor, in case a Scribase response ever reports a near-zero expiry. */
const MIN_ACCESS_COOKIE_MAX_AGE_SECONDS = 60;
/** Refresh-token cookie lifetime: long enough that the owner isn't forced to re-enter a password often. */
const REFRESH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
/** POST /login attempts allowed per IP+email before a 429 (mirrors wrangler.jsonc's LOGIN_RATE_LIMITER). */
const LOGIN_RATE_LIMIT_MESSAGE = "Too many sign-in attempts. Try again in a minute.";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

// Requests reachable without an authenticated session — just the sign-in
// form and its submit handler, plus the logout action (POST only: a GET
// route there would let a third-party page force a logout via a plain
// top-level navigation, since sameSite=Lax still sends cookies on those).
// Everything else (the SPA, the API, the MCP endpoint, and the email
// handler's HTTP surface) is gated below.
function isPublicRequest(path: string, method: string): boolean {
	if (path === "/login") return true;
	return path === "/logout" && method === "POST";
}

function scribaseConfig(env: Env): ScribaseAuthConfig | null {
	const config = { scribaseUrl: env.SCRIBASE_URL, anonKey: env.SCRIBASE_ANON_KEY, ownerEmail: env.OWNER_EMAIL };
	return isScribaseAuthConfigured(config) ? config : null;
}

function wantsJson(c: { req: { header: (name: string) => string | undefined; path: string } }): boolean {
	if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/mcp")) return true;
	const accept = c.req.header("accept") ?? "";
	return accept.includes("application/json") && !accept.includes("text/html");
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// Scribase owner-gate: replaces the previous Cloudflare Access JWT check.
// Instead of validating a `Cf-Access-Jwt-Assertion` header against
// Cloudflare's JWKS, this validates a Scribase (Supabase-compatible,
// self-hosted) access token by calling the project's own `/auth/v1/user`
// endpoint, then requires the resolved account's email to equal OWNER_EMAIL —
// mirroring the single-allow-policy the Access app would have enforced.
app.use("*", async (c, next) => {
	if (isPublicRequest(c.req.path, c.req.method)) return next();

	// Skip validation in development
	if (import.meta.env.DEV) {
		return next();
	}

	const config = scribaseConfig(c.env);
	if (!config) {
		return c.text(
			"Scribase auth must be configured in production. Set SCRIBASE_URL, SCRIBASE_ANON_KEY and OWNER_EMAIL.",
			500,
		);
	}

	const accessToken = extractAccessToken(c.req.raw);
	let result = await verifyOwnerToken(fetch, config, accessToken);

	// The access token is short-lived; transparently exchange a valid refresh
	// token for a new session once instead of forcing a re-login every hour.
	if (!result.ok && result.reason === "invalid_token") {
		const refreshToken = getCookie(c, REFRESH_TOKEN_COOKIE);
		if (refreshToken) {
			try {
				const session = await refreshSession(fetch, config.scribaseUrl, config.anonKey, refreshToken);
				const retried = await verifyOwnerToken(fetch, config, session.access_token);
				if (retried.ok) {
					setSessionCookies(c, session);
					result = retried;
				}
			} catch {
				// Refresh failed; fall through to the unauthenticated response below.
			}
		}
	}

	if (!result.ok) {
		// Uniform 401 regardless of reason (no token / invalid token / valid
		// token but not the owner's account): distinguishing them in the
		// response would let a caller who stole someone else's Scribase
		// session confirm it at least authenticates against *some* account.
		if (wantsJson(c)) {
			return c.json({ error: "unauthorized" }, 401);
		}
		deleteCookie(c, ACCESS_TOKEN_COOKIE, { path: "/" });
		deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: "/" });
		return c.redirect("/login");
	}

	return next();
});

function setSessionCookies(
	c: Context<{ Bindings: Env }>,
	session: { access_token: string; refresh_token: string; expires_in: number },
) {
	const secure = !import.meta.env.DEV;
	setCookie(c, ACCESS_TOKEN_COOKIE, session.access_token, {
		httpOnly: true,
		secure,
		sameSite: "Lax",
		path: "/",
		maxAge: Math.max(MIN_ACCESS_COOKIE_MAX_AGE_SECONDS, session.expires_in),
	});
	setCookie(c, REFRESH_TOKEN_COOKIE, session.refresh_token, {
		httpOnly: true,
		secure,
		sameSite: "Lax",
		path: "/",
		maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS,
	});
}

app.get("/login", (c) => {
	return c.html(renderLoginPage(loginQueryError(c.req.query("error"))));
});

app.post("/login", async (c) => {
	const config = scribaseConfig(c.env);
	if (!config) {
		return c.html(
			renderLoginPage("Scribase auth is not configured on this deployment yet."),
			500,
		);
	}
	const body = await c.req.parseBody();
	const email = typeof body.email === "string" ? body.email.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	if (!email || !password) {
		return c.html(renderLoginPage("Email and password are required."), 400);
	}

	// Only one account can ever legitimately sign in (OWNER_EMAIL), so this
	// endpoint is a fixed, high-value brute-force target. Key the limit on
	// IP+email so one attacker can't exhaust another's budget, and vice versa.
	const clientIp = c.req.header("cf-connecting-ip") ?? "unknown";
	const { success } = await c.env.LOGIN_RATE_LIMITER.limit({ key: `${clientIp}:${email}` });
	if (!success) {
		return c.html(renderLoginPage(LOGIN_RATE_LIMIT_MESSAGE), 429);
	}

	try {
		const session = await signInWithPassword(fetch, config.scribaseUrl, config.anonKey, email, password);
		// The password grant's response already carries the account (GoTrue's
		// `user` object); only fall back to a second /auth/v1/user round trip
		// if a server implementation omits it.
		const ownerMatch = session.user
			? isOwnerEmail(session.user.email, config.ownerEmail)
			: (await verifyOwnerToken(fetch, config, session.access_token)).ok;
		if (!ownerMatch) {
			// Valid Scribase credentials, but not the owner's account: refuse the
			// same way an invalid password would be refused, without confirming
			// to the caller that the account itself exists.
			return c.html(renderLoginPage("Invalid email or password."), 401);
		}
		setSessionCookies(c, session);
		return c.redirect("/");
	} catch (error) {
		const message = error instanceof ScribaseSignInError ? error.message : "Sign-in failed. Try again.";
		return c.html(renderLoginPage(message), 401);
	}
});

// POST only: a GET route here would let any third-party page force a logout
// via a plain navigation (sameSite=Lax still sends cookies on top-level GETs).
app.post("/logout", async (c) => {
	const config = scribaseConfig(c.env);
	const accessToken = getCookie(c, ACCESS_TOKEN_COOKIE);
	if (config && accessToken) {
		// Best effort: revoke the session at Scribase too, not just locally, so
		// a previously-stolen token pair doesn't stay valid after "logout".
		await signOut(fetch, config.scribaseUrl, config.anonKey, accessToken);
	}
	deleteCookie(c, ACCESS_TOKEN_COOKIE, { path: "/" });
	deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: "/" });
	return c.redirect("/login");
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: ForwardableEmailMessage,
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
