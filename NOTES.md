# Notes for the owner

## No live deployment exists for this product yet
`wrangler deployments list --name agentic-inbox` returns `10007: This Worker
does not exist on your account` (account `c7a5b49549dcb64f2e258db485c723ca`).
`wrangler deploy --dry-run` builds cleanly, so the code is deploy-ready, but
going live for real needs owner-only dashboard steps that cannot be scripted:

1. **Pick a real domain** with Email Routing available and set it as
   `DOMAINS` in `wrangler.jsonc` (currently the placeholder `example.com`).
2. **Create the R2 bucket**: `wrangler r2 bucket create agentic-inbox`
   (or let the "Deploy to Cloudflare" button provision it).
3. **Deploy**: `npm run deploy`.
4. **Enable one-click Cloudflare Access** on the deployed Worker (Settings >
   Domains & Routes) and set the `POLICY_AUD` / `TEAM_DOMAIN` secrets it
   shows you. The app intentionally fails closed without this in production
   — there is no safe way to skip it.
5. **Enable Email Routing** on the domain with a catch-all rule pointing at
   this Worker, and enable the `send_email` Email Service binding so
   outbound mail (and the new forwarding/auto-reply features below) can
   actually send.
6. **Create a mailbox** in the deployed app for the address you want to
   receive at.

None of this can be done without a live domain + Cloudflare dashboard
clicks, so it's left here rather than guessed at.

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
