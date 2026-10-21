// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 */
import type { Env } from "../types";
import type { AttachmentInfo } from "./schemas";

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string;
	}[],
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];

	const results: StoredAttachment[] = [];
	for (const att of attachments) {
		const attachmentId = crypto.randomUUID();
		// Sanitize filename to prevent path traversal in R2 keys
		const safeFilename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
		const key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;
		const binaryStr = atob(att.content);
		const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
		await bucket.put(key, bytes);
		results.push({
			id: attachmentId,
			email_id: emailId,
			filename: safeFilename,
			mimetype: att.type,
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition,
		});
	}
	return results;
}

export interface CopiedAttachment extends StoredAttachment {
	/** Base64-encoded bytes, so the caller can also hand this to sendEmail(). */
	content: string;
}

/**
 * Base64-encode raw bytes in fixed-size chunks to avoid blowing the call
 * stack on `String.fromCharCode(...bytes)` for large attachments.
 */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/**
 * Copy an existing email's attachments to a new email id in R2, so
 * forwarding an email carries over its original attachments the way
 * every real email client does. Without this, Forward silently dropped
 * attachments: the web UI has no attachment-upload control, so the
 * forwarded message's `attachments` was always empty and the recipient
 * never received what was forwarded.
 *
 * A fresh attachment id is generated per copy — reusing the original id
 * would collide with the still-existing attachment row for the original
 * email (same primary key, different email_id).
 *
 * R2 objects that have gone missing (e.g. manually purged) are skipped
 * rather than throwing, so a stale attachment row never blocks the
 * forward itself.
 */
export async function copyAttachments(
	bucket: Env["BUCKET"],
	originalEmailId: string,
	newEmailId: string,
	attachments?: AttachmentInfo[],
): Promise<CopiedAttachment[]> {
	if (!attachments?.length) return [];

	const results: CopiedAttachment[] = [];
	for (const att of attachments) {
		const oldKey = `attachments/${originalEmailId}/${att.id}/${att.filename}`;
		const obj = await bucket.get(oldKey);
		if (!obj) continue;

		const bytes = new Uint8Array(await obj.arrayBuffer());
		const newAttachmentId = crypto.randomUUID();
		const newKey = `attachments/${newEmailId}/${newAttachmentId}/${att.filename}`;
		await bucket.put(newKey, bytes);
		results.push({
			id: newAttachmentId,
			email_id: newEmailId,
			filename: att.filename,
			mimetype: att.mimetype,
			size: bytes.byteLength,
			content_id: att.content_id ?? null,
			disposition: att.disposition ?? "attachment",
			content: bytesToBase64(bytes),
		});
	}
	return results;
}
