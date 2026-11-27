/** Ignore detached-runtime snapshots that silently drop user data. */
export function shouldAcceptComposerDraftSnapshot(
  previous: { text: string; attachments: readonly { id: string }[] },
  next: { text: string; attachments: readonly { id: string }[] },
  explicitUserEdit: boolean,
): boolean {
  if (explicitUserEdit) return true;
  if (previous.text && !next.text) return false;
  return !previous.attachments.some((attachment) => !next.attachments.some((candidate) => candidate.id === attachment.id));
}
