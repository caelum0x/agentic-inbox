// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Deliberately standalone from vite.config.ts: that config loads the
// @cloudflare/vite-plugin Workers runtime, which unit tests for pure
// TypeScript logic (no Durable Object / Workers bindings involved) don't
// need and which breaks under Vitest's module runner. Tests that need the
// actual Workers runtime are out of scope for this config.
import { defineConfig } from "vite";

export default defineConfig({
	test: {
		include: ["workers/**/*.test.ts"],
	},
});
