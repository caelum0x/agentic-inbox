// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { isAutomatedMessage, maybeForwardEmail, maybeSendAutoReply } from "./auto-respond";

function makeEnv(sendImpl: (msg: unknown) => unknown = () => ({ messageId: "abc" })) {
	return { EMAIL: { send: vi.fn(sendImpl) } } as unknown as import("../types").Env;
}

function makeStub(shouldSendAutoReply: (threadId: string) => Promise<boolean> | boolean = () => true) {
	return { shouldSendAutoReply: vi.fn(shouldSendAutoReply) } as unknown as DurableObjectStub<import("../durableObject").MailboxDO>;
}

describe("isAutomatedMessage", () => {
	it("flags well-known automated sender prefixes", () => {
		expect(isAutomatedMessage(undefined, "Mailer-Daemon@example.com")).toBe(true);
		expect(isAutomatedMessage(undefined, "postmaster@example.com")).toBe(true);
		expect(isAutomatedMessage(undefined, "noreply@example.com")).toBe(true);
	});

	it("flags RFC 3834 Auto-Submitted headers", () => {
		const headers = [{ key: "auto-submitted", value: "auto-replied" }];
		expect(isAutomatedMessage(headers, "person@example.com")).toBe(true);
	});

	it("flags bulk/list precedence", () => {
		expect(isAutomatedMessage([{ key: "precedence", value: "bulk" }], "person@example.com")).toBe(true);
		expect(isAutomatedMessage([{ key: "precedence", value: "list" }], "person@example.com")).toBe(true);
	});

	it("does not flag a normal human sender with no special headers", () => {
		expect(isAutomatedMessage([{ key: "subject", value: "hi" }], "person@example.com")).toBe(false);
		expect(isAutomatedMessage(undefined, "person@example.com")).toBe(false);
	});
});

describe("maybeSendAutoReply", () => {
	const base = {
		mailboxId: "me@example.com",
		autoReply: { enabled: true, subject: "Away", message: "I'm away." },
		senderAddress: "person@example.com",
		threadId: "thread-1",
		headers: undefined,
	};

	it("does nothing when auto-reply is disabled", async () => {
		const env = makeEnv();
		const stub = makeStub();
		await maybeSendAutoReply({ env, stub, ...base, autoReply: { ...base.autoReply, enabled: false } });
		expect(env.EMAIL.send).not.toHaveBeenCalled();
	});

	it("does nothing when the message is empty", async () => {
		const env = makeEnv();
		const stub = makeStub();
		await maybeSendAutoReply({ env, stub, ...base, autoReply: { ...base.autoReply, message: "   " } });
		expect(env.EMAIL.send).not.toHaveBeenCalled();
	});

	it("does nothing to avoid replying to itself", async () => {
		const env = makeEnv();
		const stub = makeStub();
		await maybeSendAutoReply({ env, stub, ...base, senderAddress: "ME@example.com" });
		expect(env.EMAIL.send).not.toHaveBeenCalled();
	});

	it("does nothing for an automated sender (avoids auto-responder loops)", async () => {
		const env = makeEnv();
		const stub = makeStub();
		await maybeSendAutoReply({ env, stub, ...base, senderAddress: "mailer-daemon@example.com" });
		expect(env.EMAIL.send).not.toHaveBeenCalled();
	});

	it("does nothing when the DO reports the thread is within its cooldown window", async () => {
		const env = makeEnv();
		const stub = makeStub(() => false);
		await maybeSendAutoReply({ env, stub, ...base });
		expect(stub.shouldSendAutoReply).toHaveBeenCalledWith("thread-1");
		expect(env.EMAIL.send).not.toHaveBeenCalled();
	});

	it("sends the configured auto-reply, marked Auto-Submitted, when allowed", async () => {
		const env = makeEnv();
		const stub = makeStub(() => true);
		await maybeSendAutoReply({ env, stub, ...base });
		expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
		const [sentMessage] = (env.EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(sentMessage.to).toBe("person@example.com");
		expect(sentMessage.from).toBe("me@example.com");
		expect(sentMessage.headers["Auto-Submitted"]).toBe("auto-replied");
	});
});

describe("maybeForwardEmail", () => {
	const base = {
		mailboxId: "me@example.com",
		forwarding: { enabled: true, email: "backup@example.com" },
		subject: "Hello",
		senderAddress: "person@example.com",
		bodyHtml: "<p>hi</p>",
		bodyText: "hi",
	};

	it("does nothing when forwarding is disabled", async () => {
		const env = makeEnv();
		await maybeForwardEmail({ env, ...base, forwarding: { ...base.forwarding, enabled: false } });
		expect(env.EMAIL.send).not.toHaveBeenCalled();
	});

	it("does nothing when no forwarding address is configured", async () => {
		const env = makeEnv();
		await maybeForwardEmail({ env, ...base, forwarding: { enabled: true, email: "" } });
		expect(env.EMAIL.send).not.toHaveBeenCalled();
	});

	it("does nothing when the forwarding address is the mailbox itself (avoids a self-loop)", async () => {
		const env = makeEnv();
		await maybeForwardEmail({ env, ...base, forwarding: { enabled: true, email: "ME@example.com" } });
		expect(env.EMAIL.send).not.toHaveBeenCalled();
	});

	it("forwards to the configured address with a [Fwd] subject prefix", async () => {
		const env = makeEnv();
		await maybeForwardEmail({ env, ...base });
		expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
		const [sentMessage] = (env.EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(sentMessage.to).toBe("backup@example.com");
		expect(sentMessage.subject).toBe("[Fwd] Hello");
	});
});
