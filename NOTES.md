# Notes for the owner

## Auth model replaced: Cloudflare Access -> Scribase (2026-10-24)

The Cloudflare Access gate is **fully removed** from the code (no more
`POLICY_AUD`/`TEAM_DOMAIN`, no `jose`/JWKS validation, no dependency on
Cloudflare Zero Trust at all). It's replaced with an owner-only auth gate
backed by **Scribase** (`/Users/arhansubasi/products/supabase-plus-clone`,
the portfolio's self-hosted, Supabase-compatible auth/db backend, live at
`https://api.scribase.com`):

- `workers/lib/scribase-auth.ts` validates a Scribase (GoTrue-compatible)
  access token by calling the project's own `GET /auth/v1/user`, then
  requires the resolved account's email to exactly match `OWNER_EMAIL`.
  Only that one account can ever pass — mirrors the single-allow-policy the
  Cloudflare Access app would have enforced, not open multi-user auth.
- A real sign-in page (`/login`, plain server-rendered HTML, no SPA/JS
  framework dependency) posts to `/login`, which calls Scribase's password
  grant (`POST /auth/v1/token?grant_type=password`) and sets two httpOnly
  cookies (`sb-access-token`, `sb-refresh-token`). `/logout` (POST only)
  revokes the session at Scribase too and clears both cookies.
- Expired access tokens are silently refreshed via
  `grant_type=refresh_token` instead of forcing a re-login every hour.
- `POST /login` is rate-limited (native Workers Rate Limiting binding,
  `LOGIN_RATE_LIMITER`: 10 attempts/60s per IP+email) since this app has
  exactly one legitimate account and is otherwise a fixed brute-force
  target.
- Every path fails closed (`500 Scribase auth must be configured in
  production`) if `SCRIBASE_URL` / `SCRIBASE_ANON_KEY` / `OWNER_EMAIL`
  aren't all set — verified live, see below.
- 25 unit tests in `workers/lib/scribase-auth.test.ts` (token
  extraction, owner-email matching, remote verification, sign-in/refresh/
  sign-out, `expires_in` validation) plus 2 more pre-existing suites; all
  57 tests pass (`npx vitest run`). `npx tsc -b` and `npm run build` are
  clean. Reviewed by both `code-reviewer` and `security-reviewer` agents
  (no CRITICAL/HIGH findings outstanding — see the fixes list below).
- Verified against a real local `wrangler dev` run: unauthenticated `/`
  redirects to `/login` with stale cookies cleared; `/login` renders;
  wrong credentials show one generic "Invalid email or password." message
  (same message whether the password is wrong or the account simply isn't
  the owner, so a caller can't use it to probe which account exists);
  unauthenticated `/api/v1/config` returns `401 {"error":"unauthorized"}`
  instead of HTML; the 11th rapid `POST /login` in a 60s window returns
  `429` as designed.

### Fixes applied after the review pass
- `expires_in` from Scribase's token response is validated (falls back to
  a safe default instead of ever producing a `NaN` cookie `Max-Age`).
- `POST /login` uses the account embedded in the password-grant response
  when present, avoiding a second network round trip to `/auth/v1/user`.
- `POST /logout` now also revokes the session server-side
  (`POST /auth/v1/logout`) instead of only clearing local cookies.
- The JSON (API/MCP) unauthenticated response is a uniform `401
  {"error":"unauthorized"}` regardless of reason, matching the HTML path's
  existing behavior of never distinguishing "wrong password" from "right
  password, wrong account."
- `GET /logout` was removed (only `POST /logout` exists) so a third-party
  page can't force a logout via a plain top-level navigation.
- `GET /login?error=<code>` only ever renders one of a small fixed set of
  pre-written messages (`workers/lib/login-page.ts`'s `loginQueryError`),
  not attacker-supplied text, even though it was already HTML-escaped.
- Added the native Workers Rate Limiting binding described above.

### Known limitation carried over from the original design (not a regression)
Like the Cloudflare Access code it replaces, the auth check is skipped
entirely when `import.meta.env.DEV` is true, with no secondary runtime
check. This is correct for local dev and is the same pattern the upstream
Cloudflare Access code already used — flagging it here because the
security review called it out as a worth-knowing single point of failure:
an accidental dev-mode production build would silently disable the owner
gate. A future hardening pass could add an explicit `ENVIRONMENT=production`
var check as defense-in-depth; not done in this pass to avoid scope creep
on a day-one net-new feature.

## What is genuinely still owner-blocked

**One step, a one-time $1 card check (payment — owner-only by this
portfolio's own standing rule):**

`ereboslab` (the organization this app's Scribase project needs to live
under) has never created a project before. Creating its first project now
requires a card on file:

```
PUT /v1/organizations/ereboslab/projects/agentic-inbox
-> 402 card_required: "add a card to start: a one-time $1.00 check,
   credited to your balance, unlocks your first project (Billing > Add a
   card)"
```

This was reached live, with a real, working `SCRIBASE_ACCESS_TOKEN`
(confirmed `GET /v1/organizations` returns `ereboslab` with role `owner`) —
it is not a credential-scope problem like the old Cloudflare Access
blocker was. It is purely the one-time card charge, which this environment
has no payment method or authority to complete. (For a few hours before
this, the same call instead returned a transient `503 capacity_full`
box-wide message that said to retry in 24h — it cleared on its own; the
`card_required` response is the next, real gate behind it, not a flake.)

**Owner action**: add a card to the Scribase org `ereboslab` at
`https://console.scribase.com` (Billing > Add a card) — a one-time $1
check, credited back to the balance.

**Once that's done, finishing this is fully scripted — nothing else is
owner-only.** The exact sequence (already drafted and dry-run against the
live control API, just blocked on the step above):

1. `PUT /v1/organizations/ereboslab/projects/agentic-inbox` with
   `{"region":"aws-eu-central-1","postgres_major":17}` (`Authorization:
   Bearer $SCRIBASE_ACCESS_TOKEN`, token lives in `~/products/.env` as
   `SCRIBASE_ACCESS_TOKEN`).
2. `POST /v1/environments` to create the `production` environment
   (`organization_id: ereboslab, project_id: agentic-inbox, environment_id:
   production, kind: production, data_mode: snapshot, region:
   aws-eu-central-1, postgres_major: 17`), then poll the returned
   operation until it's ready.
3. `PATCH /v1/organizations/ereboslab/projects/agentic-inbox/environments/
   production/auth/config` with `disable_signup: false,
   external_email_enabled: true, mailer_autoconfirm: true, site_url:
   "https://agentic-inbox.subasiarhan3.workers.dev", site_name: "Agentic
   Inbox"` (a ready-made config following this portfolio's existing
   per-app schema is already sitting at
   `~/products/supabase-plus-clone/upstream/supabase/supabase/scribase/
   deploy/apps/agentic-inbox.json` — `node scripts/apps-apply.mjs --only
   agentic-inbox` from that repo will run steps 1-3 in one command once the
   card is on file).
4. `GET .../environments/production/api-keys` for the project's URL +
   anon key.
5. `POST {project_url}/auth/v1/signup` with the anon key and the owner's
   chosen email/password to create **the one and only account** (the
   owner's own account) — `mailer_autoconfirm: true` means it's usable
   immediately, no SMTP needed.
6. `PATCH .../auth/config` again with `disable_signup: true` to close
   public signup permanently (only the already-created owner account can
   ever sign in from then on; the Worker's own `OWNER_EMAIL` check is a
   second, independent layer even if this step were skipped).
7. Set `SCRIBASE_URL` to the project URL and `OWNER_EMAIL` to the owner's
   chosen email in `wrangler.jsonc` `vars`, set `SCRIBASE_ANON_KEY` as a
   Worker secret (`wrangler secret put SCRIBASE_ANON_KEY`), `npm run
   build && wrangler deploy`.
8. Verify: `curl https://agentic-inbox.subasiarhan3.workers.dev/` should
   redirect to `/login` (not 500); signing in with the owner's new
   credentials there should land on the inbox.

## Live deployment status (updated 2026-10-24)

`https://agentic-inbox.subasiarhan3.workers.dev` (account
`c7a5b49549dcb64f2e258db485c723ca`) is deployed with the new code.
Verified live with `curl`:

- `GET /` -> `500 Scribase auth must be configured in production. Set
  SCRIBASE_URL, SCRIBASE_ANON_KEY and OWNER_EMAIL.` (fails closed — no
  mailbox data exposed — because `SCRIBASE_ANON_KEY` genuinely isn't set
  yet, blocked on the card-check step above).
- `GET /login` -> `200` (the one page reachable while auth is unconfigured
  elsewhere, though signing in would still fail without a real Scribase
  project behind it).
- `GET /api/v1/config` -> same `500`, same reason.

This is a **different, narrower blocker** than before: the previous `500
Cloudflare Access must be configured in production` was blocked on a
Cloudflare API credential with Access-write scope, which never existed in
this environment, pinned to Cloudflare Zero Trust (not even enabled on the
account). That entire dependency is now gone from the code. The only thing
standing between this and fully live is the one $1 card check above.

### Still true from the 2026-10-22 pass (unrelated to auth, not re-verified this pass)
- R2 bucket `agentic-inbox`, the three Durable Object classes
  (`MailboxDO`, `EmailAgent`, `EmailMCP`), and the Workers AI (`AI`) /
  Send Email (`EMAIL`) bindings are live on the deployed Worker.
- `DOMAINS` in `wrangler.jsonc` is still the placeholder `example.com` —
  needed only for inbound/outbound mail (Email Routing), not for auth.
  Owner: pick a real domain with Email Routing available, set it as
  `DOMAINS`, redeploy.
- **Enable Email Routing** on that domain with a catch-all rule pointing
  at this Worker.
- **Create a mailbox** in the deployed app for the address you want to
  receive at, once signed in.

## What shipped this pass (2026-10-24)
- Replaced the Cloudflare Access JWT gate with the Scribase owner-auth gate
  described above: `workers/lib/scribase-auth.ts` (new, 25 tests),
  `workers/lib/login-page.ts` (new), `workers/app.ts` (rewired
  middleware + `/login` + `/logout` routes), `workers/types.ts`,
  `wrangler.jsonc` (new vars + `LOGIN_RATE_LIMITER` ratelimit binding),
  `.dev.vars.example`, `README.md`. Removed the now-unused `jose`
  dependency from `package.json`.
- Drafted `deploy/apps/agentic-inbox.json` in the Scribase repo (ready for
  `apps-apply.mjs` once the card-check step clears).
- Plan/status doc: `/Users/arhansubasi/products/plans/agentic-inbox.md`.

## What shipped in earlier passes (2026-10-21 / 2026-10-22)
- **Bug fix**: `PUT /api/v1/mailboxes/:id/folders/:id` (rename folder) had no
  guard at all — any caller could rename a system folder (`inbox`, `sent`,
  `draft`, `archive`, `trash`, `spam`) to anything, including an empty
  string, or collide it with another folder's name and trigger an unhandled
  SQLite UNIQUE-constraint exception. Fixed in `MailboxDO.updateFolder()`.
- Inbound-forwarding and vacation auto-reply wired up end to end
  (`workers/lib/auto-respond.ts` + `MailboxDO.shouldSendAutoReply`, 14
  tests).
- Settings page UI for signature, forwarding, and auto-reply.
