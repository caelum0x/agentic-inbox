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
   then redeploy.
2. **Enable one-click Cloudflare Access** on the deployed Worker (Settings >
   Domains & Routes) and set the `POLICY_AUD` / `TEAM_DOMAIN` secrets it
   shows you. The app intentionally fails closed without this in production
   — there is no safe way to skip it, and it's already fully wired up.
3. **Enable Email Routing** on the domain with a catch-all rule pointing at
   this Worker, so inbound mail (and outbound via the already-bound
   `send_email` service) actually flows.
4. **Create a mailbox** in the deployed app for the address you want to
   receive at.

None of this can be done without a live domain + Cloudflare dashboard
clicks, so it's left here rather than guessed at.

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
