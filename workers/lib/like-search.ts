// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cloudflare Durable Object SQLite rejects `LIKE` patterns above roughly 50
 * characters with an HTTP 500 (confirmed empirically: a 48-character search
 * value, wrapped as `%value%` into a 50-character pattern, succeeds; a
 * 49-character value, producing a 51-character pattern, fails). Keep each
 * generated pattern at or below that limit by splitting long search values
 * into chunks before wildcarding them, so long search terms degrade to an
 * "all chunks present" match instead of 500ing.
 */
export const MAX_LIKE_VALUE_LENGTH = 48;

/**
 * Split a raw (un-wildcarded) search value into chunks no longer than
 * MAX_LIKE_VALUE_LENGTH. Short values are returned as a single chunk
 * unchanged. Chunks concatenate back to the original value.
 */
export function chunkForLike(value: string): string[] {
	if (value.length <= MAX_LIKE_VALUE_LENGTH) return [value];
	const chunks: string[] = [];
	for (let i = 0; i < value.length; i += MAX_LIKE_VALUE_LENGTH) {
		chunks.push(value.slice(i, i + MAX_LIKE_VALUE_LENGTH));
	}
	return chunks;
}

/**
 * Build a SQL fragment requiring every chunk of `value` to independently
 * match `columnExpr LIKE %chunk%`, ANDed together. For values within the
 * length limit this degenerates to the original single-pattern condition.
 *
 * @param columnExpr - the SQL column expression to match against, e.g. "e.subject"
 * @param value - the raw (un-wildcarded) search value
 * @param addParam - binds a bound-parameter value, returning its placeholder (e.g. "?3")
 */
export function buildChunkedLikeCondition(
	columnExpr: string,
	value: string,
	addParam: (value: string) => string,
): string {
	const chunks = chunkForLike(value);
	const perChunk = chunks.map((chunk) => `${columnExpr} LIKE ${addParam(`%${chunk}%`)}`);
	return perChunk.length > 1 ? `(${perChunk.join(" AND ")})` : perChunk[0];
}

/**
 * Like buildChunkedLikeCondition, but each chunk may match any of several
 * columns (OR'd), with chunks still required to all match (ANDed). Used for
 * multi-column search fields like the free-text `query` filter (matches
 * subject/body/sender/recipient/cc/bcc) and the `to` filter (matches
 * recipient/cc/bcc).
 *
 * Known tradeoff for values longer than MAX_LIKE_VALUE_LENGTH: because each
 * chunk is matched independently per-column, a row can match even if no
 * single column contains the full original value — e.g. chunk 1 found only
 * in `recipient` and chunk 2 found only in `cc` of the same row. This is a
 * deliberate relaxation (avoiding a 500 beats an exact-match guarantee for
 * search strings this long) and mirrors the upstream issue's own proposed
 * fix; it is not expected to matter in practice since the common case for
 * long search values is an exact full-value search where the chunks are
 * trivially substrings of the same matching field.
 */
export function buildChunkedMultiColumnLikeCondition(
	columnExprs: string[],
	value: string,
	addParam: (value: string) => string,
): string {
	const chunks = chunkForLike(value);
	const perChunk = chunks.map((chunk) => {
		const columnConditions = columnExprs.map((columnExpr) => `${columnExpr} LIKE ${addParam(`%${chunk}%`)}`);
		return `(${columnConditions.join(" OR ")})`;
	});
	return perChunk.length > 1 ? `(${perChunk.join(" AND ")})` : perChunk[0];
}
