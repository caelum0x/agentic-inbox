// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
	extractAccessToken,
	fetchScribaseUser,
	isOwnerEmail,
	isScribaseAuthConfigured,
	refreshSession,
	signInWithPassword,
	signOut,
	ScribaseSignInError,
	verifyOwnerToken,
	type ScribaseAuthConfig,
} from "./scribase-auth";

const CONFIG: ScribaseAuthConfig = {
	scribaseUrl: "https://agentic-inbox.scribase.com",
	anonKey: "anon-key-123",
	ownerEmail: "subasiarhan3@gmail.com",
};

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("isScribaseAuthConfigured", () => {
	it("requires every field to be a non-empty string", () => {
		expect(isScribaseAuthConfigured(CONFIG)).toBe(true);
		expect(isScribaseAuthConfigured({ ...CONFIG, scribaseUrl: "" })).toBe(false);
		expect(isScribaseAuthConfigured({ ...CONFIG, anonKey: undefined })).toBe(false);
		expect(isScribaseAuthConfigured({})).toBe(false);
		expect(isScribaseAuthConfigured(undefined)).toBe(false);
	});
});

describe("isOwnerEmail", () => {
	it("matches case-insensitively and trims whitespace", () => {
		expect(isOwnerEmail("subasiarhan3@gmail.com", "subasiarhan3@gmail.com")).toBe(true);
		expect(isOwnerEmail("  Subasiarhan3@Gmail.com ", "subasiarhan3@gmail.com")).toBe(true);
	});

	it("rejects any other account, including similar-looking ones", () => {
		expect(isOwnerEmail("attacker@gmail.com", "subasiarhan3@gmail.com")).toBe(false);
		expect(isOwnerEmail("subasiarhan3@gmail.com.evil.com", "subasiarhan3@gmail.com")).toBe(false);
	});

	it("never matches when either side is empty", () => {
		expect(isOwnerEmail(null, "")).toBe(false);
		expect(isOwnerEmail(undefined, "")).toBe(false);
		expect(isOwnerEmail("", "")).toBe(false);
	});
});

describe("extractAccessToken", () => {
	it("prefers the Authorization bearer header", () => {
		const req = new Request("https://example.com", {
			headers: { authorization: "Bearer header-token", cookie: `sb-access-token=cookie-token` },
		});
		expect(extractAccessToken(req)).toBe("header-token");
	});

	it("falls back to the sb-access-token cookie", () => {
		const req = new Request("https://example.com", {
			headers: { cookie: "other=1; sb-access-token=cookie-token; more=2" },
		});
		expect(extractAccessToken(req)).toBe("cookie-token");
	});

	it("url-decodes the cookie value", () => {
		const req = new Request("https://example.com", {
			headers: { cookie: `sb-access-token=${encodeURIComponent("a.b.c+d")}` },
		});
		expect(extractAccessToken(req)).toBe("a.b.c+d");
	});

	it("returns null when neither is present", () => {
		const req = new Request("https://example.com");
		expect(extractAccessToken(req)).toBeNull();
	});
});

describe("fetchScribaseUser", () => {
	it("returns the user on a 200 response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { email: "owner@example.com" }));
		const user = await fetchScribaseUser(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "tok");
		expect(user).toEqual({ email: "owner@example.com" });
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://agentic-inbox.scribase.com/auth/v1/user",
			expect.objectContaining({
				method: "GET",
				headers: { authorization: "Bearer tok", apikey: CONFIG.anonKey },
			}),
		);
	});

	it("returns null on a non-2xx response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "invalid" }));
		expect(await fetchScribaseUser(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "tok")).toBeNull();
	});

	it("returns null instead of throwing on a network error", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
		expect(await fetchScribaseUser(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "tok")).toBeNull();
	});
});

describe("verifyOwnerToken", () => {
	it("fails closed with no_token when there is no token", async () => {
		const fetchImpl = vi.fn();
		const result = await verifyOwnerToken(fetchImpl, CONFIG, null);
		expect(result).toEqual({ ok: false, reason: "no_token" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("fails closed with invalid_token when the token does not resolve", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, {}));
		const result = await verifyOwnerToken(fetchImpl, CONFIG, "bad-token");
		expect(result).toEqual({ ok: false, reason: "invalid_token" });
	});

	it("fails closed with wrong_user for a valid token belonging to someone else", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { email: "someone-else@example.com" }));
		const result = await verifyOwnerToken(fetchImpl, CONFIG, "good-token");
		expect(result).toEqual({ ok: false, reason: "wrong_user" });
	});

	it("succeeds only for the owner's email", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { email: CONFIG.ownerEmail, id: "u1" }));
		const result = await verifyOwnerToken(fetchImpl, CONFIG, "good-token");
		expect(result).toEqual({ ok: true, user: { email: CONFIG.ownerEmail, id: "u1" } });
	});
});

describe("signInWithPassword", () => {
	it("returns the session on success", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { access_token: "a", refresh_token: "r", expires_in: 3600 }));
		const session = await signInWithPassword(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "e", "p");
		expect(session).toEqual({ access_token: "a", refresh_token: "r", expires_in: 3600 });
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://agentic-inbox.scribase.com/auth/v1/token?grant_type=password");
		expect(JSON.parse(init.body)).toEqual({ email: "e", password: "p" });
	});

	it("throws ScribaseSignInError on wrong credentials", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));
		await expect(signInWithPassword(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "e", "p")).rejects.toThrow(
			ScribaseSignInError,
		);
	});

	it("throws ScribaseSignInError when the network call fails", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));
		await expect(signInWithPassword(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "e", "p")).rejects.toThrow(
			ScribaseSignInError,
		);
	});

	it("throws ScribaseSignInError when the response is missing tokens", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { weird: true }));
		await expect(signInWithPassword(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "e", "p")).rejects.toThrow(
			ScribaseSignInError,
		);
	});

	it("falls back to a default expires_in when the response omits or mis-types it", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { access_token: "a", refresh_token: "r", expires_in: "soon" }));
		const session = await signInWithPassword(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "e", "p");
		expect(session.expires_in).toBe(3600);
	});

	it("falls back to a default expires_in when it is zero or negative", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { access_token: "a", refresh_token: "r", expires_in: -5 }));
		const session = await signInWithPassword(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "e", "p");
		expect(session.expires_in).toBe(3600);
	});
});

describe("refreshSession", () => {
	it("returns a new session on success", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { access_token: "a2", refresh_token: "r2", expires_in: 3600 }));
		const session = await refreshSession(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "old-refresh");
		expect(session).toEqual({ access_token: "a2", refresh_token: "r2", expires_in: 3600 });
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://agentic-inbox.scribase.com/auth/v1/token?grant_type=refresh_token");
		expect(JSON.parse(init.body)).toEqual({ refresh_token: "old-refresh" });
	});

	it("throws ScribaseSignInError when the refresh token is rejected", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "invalid_grant" }));
		await expect(refreshSession(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "old-refresh")).rejects.toThrow(
			ScribaseSignInError,
		);
	});
});

describe("signOut", () => {
	it("posts to /auth/v1/logout with the access token", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		await signOut(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "tok");
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://agentic-inbox.scribase.com/auth/v1/logout",
			expect.objectContaining({
				method: "POST",
				headers: { authorization: "Bearer tok", apikey: CONFIG.anonKey },
			}),
		);
	});

	it("never throws, even when the request fails", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));
		await expect(signOut(fetchImpl, CONFIG.scribaseUrl, CONFIG.anonKey, "tok")).resolves.toBeUndefined();
	});
});
