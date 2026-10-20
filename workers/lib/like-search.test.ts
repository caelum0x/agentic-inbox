// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { MAX_LIKE_VALUE_LENGTH, buildChunkedLikeCondition, buildChunkedMultiColumnLikeCondition, chunkForLike } from "./like-search";

describe("chunkForLike", () => {
	it("returns a single chunk unchanged for values at or below the limit", () => {
		expect(chunkForLike("short")).toEqual(["short"]);
		expect(chunkForLike("a".repeat(MAX_LIKE_VALUE_LENGTH))).toEqual(["a".repeat(MAX_LIKE_VALUE_LENGTH)]);
	});

	it("splits values above the limit into chunks no longer than the limit", () => {
		const value = "a".repeat(49);
		const chunks = chunkForLike(value);
		expect(chunks.every((c) => c.length <= MAX_LIKE_VALUE_LENGTH)).toBe(true);
	});

	it("chunks concatenate back to the original value", () => {
		const value = "cf-agentic-inbox-external-inbound-alchang-20260513T233604Z";
		expect(chunkForLike(value).join("")).toBe(value);
	});

	it("produces more than one chunk only when the value exceeds the limit", () => {
		expect(chunkForLike("a".repeat(MAX_LIKE_VALUE_LENGTH)).length).toBe(1);
		expect(chunkForLike("a".repeat(MAX_LIKE_VALUE_LENGTH + 1)).length).toBe(2);
	});
});

describe("buildChunkedLikeCondition", () => {
	it("generates a single LIKE pattern no longer than the limit + 2 wildcards for short values", () => {
		const params: string[] = [];
		const addParam = (v: string) => {
			params.push(v);
			return `?${params.length}`;
		};
		const sql = buildChunkedLikeCondition("e.sender", "alice", addParam);
		expect(sql).toBe("e.sender LIKE ?1");
		expect(params).toEqual(["%alice%"]);
	});

	it("never generates a bound LIKE pattern longer than MAX_LIKE_VALUE_LENGTH + 2", () => {
		const longValue = "cf-agentic-inbox-external-inbound-alchang-20260513T233604Z-extra-long-suffix";
		const params: string[] = [];
		const addParam = (v: string) => {
			params.push(v);
			return `?${params.length}`;
		};
		buildChunkedLikeCondition("e.subject", longValue, addParam);
		for (const p of params) {
			expect(p.length).toBeLessThanOrEqual(MAX_LIKE_VALUE_LENGTH + 2);
		}
	});

	it("ANDs multiple chunk conditions together for long values", () => {
		const longValue = "a".repeat(100);
		const params: string[] = [];
		const addParam = (v: string) => {
			params.push(v);
			return `?${params.length}`;
		};
		const sql = buildChunkedLikeCondition("e.subject", longValue, addParam);
		expect(sql).toContain(" AND ");
		expect(sql.startsWith("(")).toBe(true);
		expect(params.length).toBeGreaterThan(1);
	});

	it("a value exactly at the documented regression boundary (49 chars) still produces a valid, bounded condition", () => {
		// The upstream-reported regression: a 49-char value wrapped naively as
		// `%value%` becomes a 51-char pattern, which Durable Object SQLite 500s on.
		const value = "cf-agentic-inbox-external-inbound-alchang-2026051"; // 49 chars
		expect(value.length).toBe(49);
		const params: string[] = [];
		const addParam = (v: string) => {
			params.push(v);
			return `?${params.length}`;
		};
		buildChunkedLikeCondition("e.subject", value, addParam);
		for (const p of params) {
			expect(p.length).toBeLessThanOrEqual(50);
		}
	});
});

describe("buildChunkedMultiColumnLikeCondition", () => {
	it("ORs columns together per chunk for short values", () => {
		const params: string[] = [];
		const addParam = (v: string) => {
			params.push(v);
			return `?${params.length}`;
		};
		const sql = buildChunkedMultiColumnLikeCondition(["e.recipient", "e.cc", "e.bcc"], "bob", addParam);
		expect(sql).toBe("(e.recipient LIKE ?1 OR e.cc LIKE ?2 OR e.bcc LIKE ?3)");
		expect(params).toEqual(["%bob%", "%bob%", "%bob%"]);
	});

	it("never generates a bound LIKE pattern longer than MAX_LIKE_VALUE_LENGTH + 2, even across multiple columns", () => {
		const longValue = "a".repeat(120);
		const params: string[] = [];
		const addParam = (v: string) => {
			params.push(v);
			return `?${params.length}`;
		};
		buildChunkedMultiColumnLikeCondition(["e.subject", "e.body", "e.sender"], longValue, addParam);
		for (const p of params) {
			expect(p.length).toBeLessThanOrEqual(MAX_LIKE_VALUE_LENGTH + 2);
		}
	});
});
