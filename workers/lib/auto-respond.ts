// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Auto-reply (vacation responder) and inbound-forwarding logic.
 *
 * Both features were already present in the mailbox settings data model
 * (`MailboxSettings.autoReply` / `.forwarding`, set via the API) but never
 * actually acted on when an email arrived — the settings were stored and
 * silently ignored. This module wires them up for real.
 */
import type { MailboxDO } from "../durableObject";
import { sendEmail } from "../email-sender";
import { textToHtml } from "./email-helpers";
import type { Env } from "../types";

export interface AutoReplySettings {
	enabled: boolean;
	subject: string;
	message: string;
}

export interface ForwardingSettings {
	enabled: boolean;
	email: string;
}

const AUTOMATED_SENDER_PREFIXES = ["mailer-daemon@", "postmaster@", "noreply@", "no-reply@"];
const AUTO_SUBMITTED_VALUES = ["auto-replied", "auto-generated", "auto-notified"];

/**
 * True if the inbound message is itself an automated message (RFC 3834
 * `Auto-Submitted`, bulk/list precedence, or a well-known automated sender
 * prefix). Auto-reply must never fire for these, or two mailboxes with
 * vacation responders enabled (or a mailbox replying to a no-reply sender)
 * would loop forever.
 */
export function isAutomatedMessage(
	headers: { key: string; value: string }[] | undefined,
	senderAddress: string,
): boolean {
	const sender = senderAddress.toLowerCase();
	if (AUTOMATED_SENDER_PREFIXES.some((prefix) => sender.startsWith(prefix))) return true;
	if (!headers) return false;

	const autoSubmitted = headers.find((h) => h.key.toLowerCase() === "auto-submitted")?.value?.toLowerCase();
	if (autoSubmitted && AUTO_SUBMITTED_VALUES.some((v) => autoSubmitted.includes(v))) return true;

	const precedence = headers.find((h) => h.key.toLowerCase() === "precedence")?.value?.toLowerCase();
	if (precedence === "bulk" || precedence === "list" || precedence === "auto_reply") return true;

	return false;
}

/**
 * Send the mailbox's configured vacation-responder reply for a newly
 * received email, at most once per thread per 24h. The once-per-thread
 * dedup is enforced by `MailboxDO.shouldSendAutoReply`, which persists the
 * last-sent timestamp in the DO's own storage so it is race-free per
 * mailbox and survives Worker restarts.
 */
export async function maybeSendAutoReply(opts: {
	env: Env;
	stub: DurableObjectStub<MailboxDO>;
	mailboxId: string;
	autoReply: AutoReplySettings | undefined;
	senderAddress: string;
	threadId: string;
	headers: { key: string; value: string }[] | undefined;
}): Promise<void> {
	const { env, stub, mailboxId, autoReply, senderAddress, threadId, headers } = opts;
	if (!autoReply?.enabled || !autoReply.message?.trim()) return;
	if (!senderAddress || senderAddress.toLowerCase() === mailboxId.toLowerCase()) return;
	if (isAutomatedMessage(headers, senderAddress)) return;

	const allowed = await (stub as unknown as { shouldSendAutoReply(threadId: string): Promise<boolean> }).shouldSendAutoReply(threadId);
	if (!allowed) return;

	await sendEmail(env.EMAIL, {
		to: senderAddress,
		from: mailboxId,
		subject: autoReply.subject?.trim() || "Auto-Reply",
		html: textToHtml(autoReply.message),
		text: autoReply.message,
		// RFC 3834: mark this as an automated response so other auto-responders
		// (including our own on a different mailbox) can recognize and skip it.
		headers: { "Auto-Submitted": "auto-replied" },
	});
}

/**
 * Forward a copy of a newly received email to the mailbox's configured
 * external forwarding address, when forwarding is enabled.
 */
export async function maybeForwardEmail(opts: {
	env: Env;
	mailboxId: string;
	forwarding: ForwardingSettings | undefined;
	subject: string;
	senderAddress: string;
	bodyHtml: string;
	bodyText: string;
}): Promise<void> {
	const { env, mailboxId, forwarding, subject, senderAddress, bodyHtml, bodyText } = opts;
	const target = forwarding?.email?.trim().toLowerCase();
	if (!forwarding?.enabled || !target) return;
	if (target === mailboxId.toLowerCase()) return; // guard against a pointless self-forward loop

	await sendEmail(env.EMAIL, {
		to: target,
		from: mailboxId,
		subject: `[Fwd] ${subject}`,
		html: `<p>Forwarded message from ${senderAddress}:</p><hr>${bodyHtml}`,
		text: `Forwarded message from ${senderAddress}:\n\n${bodyText}`,
	});
}
