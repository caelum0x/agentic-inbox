// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Owner-only authentication against Scribase (a self-hosted,
// Supabase-compatible auth/db backend — see
// https://api.scribase.com and /Users/arhansubasi/products/supabase-plus-clone).
//
// Replaces the previous Cloudflare Access JWT gate: instead of validating a
// `Cf-Access-Jwt-Assertion` header against Cloudflare's JWKS, this validates a
// Scribase-issued (GoTrue-compatible) access token by asking the Scribase
// project's own `/auth/v1/user` endpoint whether it is live, then checks the
// returned account's email against the configured owner email. Only that one
// account may ever pass — this intentionally mirrors the Cloudflare Access
// policy it replaces (a single allow-listed email), not open multi-user auth.

export const ACCESS_TOKEN_COOKIE = "sb-access-token";
export const REFRESH_TOKEN_COOKIE = "sb-refresh-token";

export interface ScribaseUser {
	id?: string;
	email?: string | null;
	[key: string]: unknown;
}

export type AuthFailureReason = "no_token" | "invalid_token" | "wrong_user";

export type AuthResult =
	| { ok: true; user: ScribaseUser }
	| { ok: false; reason: AuthFailureReason };

export interface ScribaseAuthConfig {
	/** Base URL of the Scribase project's auth API, e.g. `https://<project>.scribase.com`. */
	scribaseUrl: string;
	/** The project's public anon/publishable key — safe to ship, required by GoTrue as `apikey`. */
	anonKey: string;
	/** The only email allowed through — case-insensitive, exact match. */
	ownerEmail: string;
}

/** True when every field required to run the Scribase auth gate is present and non-empty. */
export function isScribaseAuthConfigured(
	config: Partial<ScribaseAuthConfig> | undefined | null,
): config is ScribaseAuthConfig {
	return Boolean(config?.scribaseUrl && config?.anonKey && config?.ownerEmail);
}

/** Case-insensitive, whitespace-trimmed exact email match. Never matches two empty strings. */
export function isOwnerEmail(email: string | null | undefined, ownerEmail: string): boolean {
	const normalizedOwner = ownerEmail.trim().toLowerCase();
	const normalizedCandidate = (email ?? "").trim().toLowerCase();
	return normalizedOwner.length > 0 && normalizedCandidate === normalizedOwner;
}

/**
 * Pull the bearer token out of a request: an `Authorization: Bearer <token>`
 * header first (for API clients / the MCP endpoint), falling back to the
 * `sb-access-token` cookie (for browser navigation of the SPA).
 */
export function extractAccessToken(request: Request, cookieHeader?: string | null): string | null {
	const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization");
	if (authHeader) {
		const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
		if (match?.[1]) return match[1];
	}
	const cookies = cookieHeader ?? request.headers.get("cookie");
	if (!cookies) return null;
	for (const part of cookies.split(";")) {
		const [rawName, ...rawValue] = part.trim().split("=");
		if (rawName === ACCESS_TOKEN_COOKIE) {
			const value = rawValue.join("=");
			return value ? decodeURIComponent(value) : null;
		}
	}
	return null;
}

/**
 * `GET {scribaseUrl}/auth/v1/user` — ask the project's auth service whether
 * this access token is currently valid, and who it belongs to. Returns `null`
 * for any non-2xx response or network/parse failure; never throws, so callers
 * can fail closed uniformly.
 */
export async function fetchScribaseUser(
	fetchImpl: typeof fetch,
	scribaseUrl: string,
	anonKey: string,
	accessToken: string,
): Promise<ScribaseUser | null> {
	try {
		const response = await fetchImpl(`${scribaseUrl.replace(/\/+$/, "")}/auth/v1/user`, {
			method: "GET",
			headers: {
				authorization: `Bearer ${accessToken}`,
				apikey: anonKey,
			},
		});
		if (!response.ok) return null;
		const body = (await response.json()) as ScribaseUser;
		if (!body || typeof body !== "object") return null;
		return body;
	} catch {
		return null;
	}
}

/**
 * The full owner-gate check: extract + validate the token, then require the
 * resolved account's email to match `config.ownerEmail`. Fails closed on any
 * missing token, invalid/expired token, or a valid-but-non-owner account.
 */
export async function verifyOwnerToken(
	fetchImpl: typeof fetch,
	config: ScribaseAuthConfig,
	accessToken: string | null,
): Promise<AuthResult> {
	if (!accessToken) return { ok: false, reason: "no_token" };
	const user = await fetchScribaseUser(fetchImpl, config.scribaseUrl, config.anonKey, accessToken);
	if (!user) return { ok: false, reason: "invalid_token" };
	if (!isOwnerEmail(user.email, config.ownerEmail)) return { ok: false, reason: "wrong_user" };
	return { ok: true, user };
}

export interface ScribaseSession {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	user?: ScribaseUser;
}

/** Fallback access-token lifetime (seconds) when the auth service omits or sends an invalid `expires_in`. */
const DEFAULT_SESSION_EXPIRES_IN_SECONDS = 3600;

export class ScribaseSignInError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScribaseSignInError";
	}
}

async function tokenGrant(
	fetchImpl: typeof fetch,
	scribaseUrl: string,
	anonKey: string,
	grantType: "password" | "refresh_token",
	body: Record<string, string>,
	failureMessage: string,
): Promise<ScribaseSession> {
	let response: Response;
	try {
		response = await fetchImpl(`${scribaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=${grantType}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				apikey: anonKey,
			},
			body: JSON.stringify(body),
		});
	} catch {
		throw new ScribaseSignInError("Could not reach the sign-in service. Try again shortly.");
	}
	if (!response.ok) {
		throw new ScribaseSignInError(failureMessage);
	}
	const data = (await response.json().catch(() => null)) as ScribaseSession | null;
	if (!data?.access_token || !data.refresh_token) {
		throw new ScribaseSignInError("Sign-in service returned an unexpected response.");
	}
	// Defend against a missing/non-numeric/non-positive expires_in: callers
	// (see setSessionCookies in app.ts) use it directly as a cookie Max-Age,
	// where an invalid value would otherwise silently become NaN.
	const expiresIn =
		typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0
			? data.expires_in
			: DEFAULT_SESSION_EXPIRES_IN_SECONDS;
	return { ...data, expires_in: expiresIn };
}

/**
 * `POST {scribaseUrl}/auth/v1/token?grant_type=password` — the Supabase/GoTrue
 * password grant. Throws {@link ScribaseSignInError} with a user-safe message
 * on wrong credentials or an unreachable auth service.
 */
export async function signInWithPassword(
	fetchImpl: typeof fetch,
	scribaseUrl: string,
	anonKey: string,
	email: string,
	password: string,
): Promise<ScribaseSession> {
	return tokenGrant(
		fetchImpl,
		scribaseUrl,
		anonKey,
		"password",
		{ email, password },
		"Invalid email or password.",
	);
}

/**
 * `POST {scribaseUrl}/auth/v1/token?grant_type=refresh_token` — exchange a
 * refresh token for a new session, so the owner is not forced to re-enter a
 * password every time the short-lived access token expires. Throws
 * {@link ScribaseSignInError} when the refresh token is invalid/expired or the
 * auth service is unreachable.
 */
export async function refreshSession(
	fetchImpl: typeof fetch,
	scribaseUrl: string,
	anonKey: string,
	refreshToken: string,
): Promise<ScribaseSession> {
	return tokenGrant(
		fetchImpl,
		scribaseUrl,
		anonKey,
		"refresh_token",
		{ refresh_token: refreshToken },
		"Session expired. Please sign in again.",
	);
}

/**
 * `POST {scribaseUrl}/auth/v1/logout` — revoke a session server-side (GoTrue
 * invalidates the refresh token family tied to this access token). Best
 * effort: swallows failures, since the caller is already clearing its local
 * cookies regardless and a slow/unreachable auth service should not block
 * logging out of the app itself.
 */
export async function signOut(fetchImpl: typeof fetch, scribaseUrl: string, anonKey: string, accessToken: string): Promise<void> {
	try {
		await fetchImpl(`${scribaseUrl.replace(/\/+$/, "")}/auth/v1/logout`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${accessToken}`,
				apikey: anonKey,
			},
		});
	} catch {
		// Ignored — see docstring.
	}
}
