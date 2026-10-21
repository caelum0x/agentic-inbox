// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button, Dialog, Input, Text } from "@cloudflare/kumo";
import { FileIcon, FloppyDiskIcon, PaperclipIcon, PaperPlaneTiltIcon, XIcon } from "@phosphor-icons/react";
import { useRef } from "react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import { formatBytes } from "~/lib/utils";
import RichTextEditor from "./RichTextEditor";
import { useUIStore } from "~/hooks/useUIStore";

export default function ComposeEmail() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	
	const { isComposeModalOpen, closeComposeModal } = useUIStore();

	const {
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		showCcBcc,
		setShowCcBcc,
		subject,
		setSubject,
		body,
		setBody,
		attachments,
		isAttaching,
		addAttachmentFiles,
		removeAttachment,
		error,
		isSavingDraft,
		isSending,
		formTitle,
		handleSaveDraft,
		handleSend,
	} = useComposeForm(mailboxId, folder);

	const fileInputRef = useRef<HTMLInputElement>(null);

	return (
		<Dialog.Root
			open={isComposeModalOpen}
			onOpenChange={(open) => !open && !isSending && closeComposeModal()}
		>
			<Dialog size="lg" className="p-6 max-h-[85vh] overflow-y-auto">
				<Dialog.Title className="text-lg font-semibold mb-5">
					{formTitle}
				</Dialog.Title>
				<form onSubmit={(e) => handleSend(e, closeComposeModal)} className="space-y-4">
					{error && <Banner variant="error" text={error} />}
					<div className="flex items-center gap-2">
						<div className="flex-1">
							<Input
								label="To"
								type="text"
								placeholder="recipient@example.com, another@example.com"
								size="sm"
								value={to}
								onChange={(e) => setTo(e.target.value)}
								required
							/>
						</div>
						{!showCcBcc && (
							<button
								type="button"
								onClick={() => setShowCcBcc(true)}
								className="shrink-0 text-xs text-kumo-link hover:text-kumo-link-hover font-medium mt-5"
							>
								CC / BCC
							</button>
						)}
					</div>
					{showCcBcc && (
						<Input
							label="CC"
							type="text"
							size="sm"
							value={cc}
							onChange={(e) => setCc(e.target.value)}
							placeholder="Separate multiple addresses with commas"
						/>
					)}
					{showCcBcc && (
						<Input
							label="BCC"
							type="text"
							size="sm"
							value={bcc}
							onChange={(e) => setBcc(e.target.value)}
							placeholder="Separate multiple addresses with commas"
						/>
					)}
					<Input
						label="Subject"
						type="text"
						placeholder="Email subject"
						size="sm"
						value={subject}
						onChange={(e) => setSubject(e.target.value)}
						required
					/>
					<div>
						<Text size="sm" DANGEROUS_className="font-medium mb-1.5 block">
							Message
						</Text>
						<RichTextEditor value={body} onChange={setBody} />
					</div>
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<Text size="sm" DANGEROUS_className="font-medium block">
								Attachments
							</Text>
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								disabled={isAttaching}
								className="inline-flex items-center gap-1.5 text-xs font-medium text-kumo-link hover:text-kumo-link-hover disabled:opacity-50"
							>
								<PaperclipIcon size={14} />
								{isAttaching ? "Attaching..." : "Attach files"}
							</button>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								className="hidden"
								onChange={(e) => {
									if (e.target.files?.length) addAttachmentFiles(e.target.files);
									e.target.value = "";
								}}
							/>
						</div>
						{attachments.length > 0 && (
							<div className="flex flex-wrap gap-2">
								{attachments.map((att) => (
									<span
										key={att.id}
										className="inline-flex items-center gap-2 rounded-md border border-kumo-line px-2.5 py-1.5 text-xs"
									>
										<FileIcon size={14} className="text-kumo-subtle shrink-0" />
										<span className="font-medium truncate max-w-[160px]">{att.filename}</span>
										<span className="text-kumo-subtle">{formatBytes(att.size)}</span>
										<button
											type="button"
											onClick={() => removeAttachment(att.id)}
											aria-label={`Remove ${att.filename}`}
											className="text-kumo-subtle hover:text-kumo-default"
										>
											<XIcon size={12} />
										</button>
									</span>
								))}
							</div>
						)}
					</div>
					<div className="flex justify-between items-center pt-2">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={closeComposeModal}
							disabled={isSending}
						>
							Discard
						</Button>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								loading={isSavingDraft}
								disabled={isSending}
								icon={<FloppyDiskIcon size={14} />}
								onClick={handleSaveDraft}
							>
								{isSavingDraft ? "Saving..." : "Save as Draft"}
							</Button>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isSending}
								disabled={isSavingDraft || isSending}
								icon={<PaperPlaneTiltIcon size={14} />}
							>
								{isSending ? "Sending..." : "Send"}
							</Button>
						</div>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
