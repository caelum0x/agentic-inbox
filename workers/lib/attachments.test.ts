// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { copyAttachments } from "./attachments";
import type { AttachmentInfo } from "./schemas";

function makeBucket(objects: Record<string, { body: string }>) {
	return {
		get: vi.fn(async (key: string) => {
			const obj = objects[key];
			if (!obj) return null;
			return {
				body: obj.body,
				arrayBuffer: async () => new TextEncoder().encode(obj.body).buffer,
			} as unknown as R2ObjectBody;
		}),
		put: vi.fn(async (_key: string, _value: unknown) => ({}) as R2Object),
	};
}

describe("copyAttachments", () => {
	it("returns an empty array when there is nothing to copy", async () => {
		const bucket = makeBucket({});
		const result = await copyAttachments(bucket as any, "orig-email", "new-email", []);
		expect(result).toEqual([]);
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it("copies each attachment's R2 object to a new key under the new email id", async () => {
		const attachments: AttachmentInfo[] = [
			{ id: "att-1", filename: "invoice.pdf", mimetype: "application/pdf", size: 1234, content_id: null, disposition: "attachment" },
		];
		const bucket = makeBucket({
			"attachments/orig-email/att-1/invoice.pdf": { body: "pdf-bytes" },
		});

		const result = await copyAttachments(bucket as any, "orig-email", "new-email", attachments);

		expect(bucket.get).toHaveBeenCalledWith("attachments/orig-email/att-1/invoice.pdf");
		expect(bucket.put).toHaveBeenCalledTimes(1);
		const [newKey] = bucket.put.mock.calls[0];
		expect(newKey).toMatch(/^attachments\/new-email\/[^/]+\/invoice\.pdf$/);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			email_id: "new-email",
			filename: "invoice.pdf",
			mimetype: "application/pdf",
			disposition: "attachment",
		});
		// A fresh attachment id must be generated — reusing the original id
		// would collide with its still-existing primary-key row in the DB.
		expect(result[0].id).not.toBe("att-1");
		// The caller needs base64 content to re-attach to the outgoing send.
		expect(result[0].content).toBe(Buffer.from("pdf-bytes").toString("base64"));
	});

	it("skips attachments whose R2 object is missing instead of throwing", async () => {
		const attachments: AttachmentInfo[] = [
			{ id: "att-missing", filename: "ghost.png", mimetype: "image/png", size: 10, content_id: null, disposition: "inline" },
		];
		const bucket = makeBucket({});

		const result = await copyAttachments(bucket as any, "orig-email", "new-email", attachments);

		expect(result).toEqual([]);
		expect(bucket.put).not.toHaveBeenCalled();
	});
});
