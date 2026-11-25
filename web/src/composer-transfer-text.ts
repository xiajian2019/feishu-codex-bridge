/** Append imported text without changing any existing draft content. */
export function appendComposerTransferText(current: string, incoming: string): string {
  if (!incoming.trim()) return current;
  if (!current) return incoming;
  const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  return current + separator + incoming;
}
