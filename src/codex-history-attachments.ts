import { lstat, realpath, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Remove one attachment known to this service instance.
 *
 * The caller supplies an attachment ID from its in-memory ownership record;
 * this helper never scans a directory or follows a symlink at the file path.
 */
export async function unlinkOwnedCodexHistoryAttachment(
  rootDirectory: string,
  filePath: string,
  attachmentId: string,
): Promise<boolean> {
  const root = resolve(rootDirectory);
  const target = resolve(filePath);
  const fileName = basename(target);
  if (!UUID_PATTERN.test(attachmentId) || dirname(target) !== root) return false;

  const extension = fileName.startsWith(`${attachmentId}.`)
    ? fileName.slice(attachmentId.length)
    : "";
  if (!/^\.[a-z0-9]{1,10}$/i.test(extension)) return false;

  try {
    const [rootInfo, canonicalRoot, targetInfo] = await Promise.all([
      lstat(root),
      realpath(root),
      lstat(target),
    ]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || canonicalRoot !== root) return false;
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) return false;
    await unlink(target);
    return true;
  } catch {
    return false;
  }
}
