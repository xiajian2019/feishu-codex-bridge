export interface NormalizedSessionPathInput {
  path: string;
  hasTrailingSlash: boolean;
}

export function normalizeSessionPathInput(value: string): NormalizedSessionPathInput | null {
  const raw = value.trim().replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes("\0")) return null;
  if ([...raw].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) return null;
  const hasTrailingSlash = raw.endsWith("/");
  const parts = raw.split("/");
  if (parts.some((part) => part === "..")) return null;
  const path = parts.filter((part) => part && part !== ".").join("/");
  return path ? { path, hasTrailingSlash } : null;
}

export function sessionPathParent(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}

export function sessionPathName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}
