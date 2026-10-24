// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// A small, dependency-free HTML sign-in page served directly by the Hono app
// (not part of the React Router SPA bundle) — this is the only route an
// unauthenticated visitor can reach, so it is deliberately self-contained.

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Fixed vocabulary for `GET /login?error=<code>` so an attacker-crafted link
 * cannot inject arbitrary text into the page — only one of these known,
 * pre-written messages can ever be shown from a query parameter. Messages
 * generated server-side after an actual sign-in attempt (see `POST /login`
 * in app.ts) are passed directly to {@link renderLoginPage} instead, since
 * they never originate from user-supplied request data.
 */
const LOGIN_QUERY_ERRORS: Record<string, string> = {
	session_expired: "Your session expired. Please sign in again.",
};

export function loginQueryError(code: string | undefined | null): string | null {
	if (!code) return null;
	return LOGIN_QUERY_ERRORS[code] ?? null;
}

export function renderLoginPage(errorMessage?: string | null): string {
	const errorBlock = errorMessage
		? `<p role="alert" style="color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;margin:0 0 16px;font-size:14px;">${escapeHtml(errorMessage)}</p>`
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — Agentic Inbox</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  main { width: 100%; max-width: 360px; padding: 32px; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #64748b; font-size: 13px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #d7dce3; border-radius: 8px; font-size: 14px; margin-bottom: 14px; }
  button { width: 100%; padding: 10px 12px; border: none; border-radius: 8px; background: #111827; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:hover { background: #1f2937; }
</style>
</head>
<body>
<main>
  <h1>Agentic Inbox</h1>
  <p class="sub">Sign in with your Scribase account.</p>
  ${errorBlock}
  <form method="post" action="/login">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;
}
