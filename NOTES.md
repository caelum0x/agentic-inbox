# Notes for the owner

## Live deployment status (updated 2026-10-22)
The Worker is now actually deployed and provisioned:
`https://agentic-inbox.subasiarhan3.workers.dev` (account
`c7a5b49549dcb64f2e258db485c723ca`). Verified live with `curl` — it
correctly fails closed with `500 Cloudflare Access must be configured in
production` since Access isn't set up yet, so no mailbox data is exposed.

Provisioned this pass:
- **R2 bucket** `agentic-inbox` created (was missing — `r2_buckets_list`
  returned zero buckets before this).
- **Durable Object classes** (`MailboxDO`, `EmailAgent`, `EmailMCP`) and the
  **Workers AI** (`AI`) and **Send Email** (`EMAIL`) bindings are now live
  on the deployed Worker — confirmed in the `wrangler deploy` bindings
  table.

Remaining owner-only steps (cannot be scripted, left exactly as before):

1. **Pick a real domain** with Email Routing available and set it as
   `DOMAINS` in `wrangler.jsonc` (currently the placeholder `example.com`),
   then redeploy. This is **only** needed for inbound/outbound mail (item
   3 below) — it is NOT required for Cloudflare Access (see item 2):
   Access works directly on the `workers.dev` subdomain, no custom domain
   needed, per
   https://developers.cloudflare.com/workers/configuration/cloudflare-access/.
2. **Enable Cloudflare Access** on the deployed Worker and set the
   `POLICY_AUD` / `TEAM_DOMAIN` secrets it generates. Re-checked 2026-10-22
   whether this is truly owner-only or could be done via API — it genuinely
   needs one owner click, but it is much narrower than "dashboard setup":
   - Zero Trust is **not yet enabled** on this Cloudflare account at all
     (`GET /accounts/{id}/access/organizations` returns
     `access.api.error.not_enabled`). Enabling it, plus creating the Access
     app (`POST /accounts/{id}/access/apps`, destination type `worker`,
     `worker_id` = agentic-inbox's ID) and an allow policy for
     `subasiarhan3@gmail.com`, is a normal API call
     (`POST /accounts/{id}/access/organizations` creates the Zero Trust org
     in one call per
     https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/)
     — **not** inherently an interactive-only dashboard flow.
   - The blocker is purely credentials: none of the credentials available in
     this environment carry Access write scope.
     `CLOUDFLARE_DNS_API_TOKEN` in `~/products/.env` is DNS-only (confirmed:
     `GET .../access/organizations` with it returns a bare auth error, no
     Access scope at all). The `wrangler` OAuth token
     (`wrangler whoami`) has `workers`/`d1`/`r2`/etc but no `access.*` scope.
     The Cloudflare API MCP connector session has `access.read` /
     `access-acct.read` (read-only) but not the write scopes
     (`access.write`, `access-acct.write`); calling the write endpoint
     through it returns "needs additional permissions ... run /mcp to
     re-authenticate" — that re-auth is a browser OAuth consent click only
     the owner can approve.
   - **One owner action unblocks all of this**: either (a) approve the MCP
     reconnect/scope-upgrade prompt for the Cloudflare API connector, or (b)
     create a new Cloudflare API token at
     https://dash.cloudflare.com/profile/api-tokens with the permission
     groups "Access: Organizations, Identity Providers, and Groups - Write"
     and "Access: Apps and Policies - Write" on this account, and drop it
     into `~/products/.env` as e.g. `CLOUDFLARE_ACCESS_API_TOKEN`. Either
     one lets a future pass finish the rest (enable Zero Trust org, create
     the Access app + policy, set the Worker secrets, verify the redirect)
     without any further owner steps.
3. **Enable Email Routing** on the domain with a catch-all rule pointing at
   this Worker, so inbound mail (and outbound via the already-bound
   `send_email` service) actually flows.
4. **Create a mailbox** in the deployed app for the address you want to
   receive at.

Items 1/3/4 need a live domain; item 2 (Access) does not — it was wrongly
bundled with the domain requirement in an earlier note. It only needs the
credential upgrade described above.

## What shipped this pass (2026-10-22)
- **Bug fix**: `PUT /api/v1/mailboxes/:id/folders/:id` (rename folder) had no
  guard at all — any caller could rename a system folder (`inbox`, `sent`,
  `draft`, `archive`, `trash`, `spam`) to anything, including an empty
  string, or collide it with another folder's name and trigger an unhandled
  SQLite UNIQUE-constraint exception. `deleteFolder` already protected
  system folders via `is_deletable`; `updateFolder` was missing the same
  check. Fixed in `MailboxDO.updateFolder()` (now returns a typed
  `{error: "not_found" | "system_folder" | "duplicate_name"}` instead of
  throwing or silently succeeding) and the route in `workers/index.ts` now
  validates non-empty names and maps each error to the right HTTP status
  (400/403/404/409). Verified against the real local dev worker: created a
  mailbox, confirmed renaming `inbox`/`spam` now 403s and leaves the name
  untouched, confirmed renaming a genuine custom folder still works (200),
  and confirmed the new empty-name (400), duplicate-name (409), and
  not-found (404) cases all return clean errors instead of a 500.

## What shipped this pass (2026-10-21)
- Re-verified the mailbox-delete privacy fix (`MailboxDO.purgeAllData()` +
  R2 attachment cleanup in `DELETE /api/v1/mailboxes/:mailboxId`) is still
  intact — confirmed by reading the code and running the existing tests.
- **New feature**: inbound-forwarding and vacation auto-reply are now
  actually wired up. `MailboxSettings.forwarding` / `.autoReply` existed in
  the data model and were settable via the API, but `receiveEmail()` never
  read them — mail just sat there. See `workers/lib/auto-respond.ts` +
  `MailboxDO.shouldSendAutoReply` (14 new tests).
- **New feature**: the Settings page now has UI for signature, forwarding,
  and auto-reply (previously only Display Name and the AI agent prompt were
  editable in the UI at all — the rest only existed as API fields nobody
  could reach from the app).
