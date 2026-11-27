/** Remove transfer capabilities and user-provided values before exposing an error in diagnostics. */
export function formatTransferDiagnosticError(cause: unknown, secrets: readonly string[]): string {
  const name = cause instanceof Error ? cause.name.replace(/[^a-z0-9_.-]/gi, "").slice(0, 40) || "Error" : "Error";
  let message = cause instanceof Error ? cause.message : String(cause);
  message = message.replace(/(?:https?|capacitor):\/\/[^\s]+/gi, "[地址已隐藏]");
  for (const secret of [...secrets].filter((value) => value.length >= 3).sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join("[已隐藏]");
  }
  message = message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [已隐藏]")
    .replace(/\b(token|code|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[已隐藏]")
    .replace(/\/(?:Users|private|var|tmp|home|storage|data)\/[^\s,;]+/g, "[路径已隐藏]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
  return `${name}: ${message || "无详细信息"}`;
}
