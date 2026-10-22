import type { IDisposable, Terminal } from "@xterm/xterm";

export type TerminalLinkMatch = {
  text: string;
  url: string;
  start: number;
  end: number;
};

const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;

function trimTerminalUrl(value: string): string {
  let result = value.replace(/[.,;:!?]+$/g, "");
  while (result.endsWith(")") && (result.match(/\(/g)?.length ?? 0) < (result.match(/\)/g)?.length ?? 0)) {
    result = result.slice(0, -1);
  }
  while (result.endsWith("]") && (result.match(/\[/g)?.length ?? 0) < (result.match(/\]/g)?.length ?? 0)) {
    result = result.slice(0, -1);
  }
  while (result.endsWith("}") && (result.match(/\{/g)?.length ?? 0) < (result.match(/\}/g)?.length ?? 0)) {
    result = result.slice(0, -1);
  }
  return result;
}

export function findTerminalLinkMatches(value: string): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  for (const match of value.matchAll(HTTP_URL_PATTERN)) {
    const rawText = match[0];
    const text = trimTerminalUrl(rawText);
    const start = match.index ?? 0;
    if (!text) continue;
    try {
      const url = new URL(text);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      matches.push({ text, url: url.href, start, end: start + text.length });
    } catch {
      // Ignore malformed terminal text that only resembles a URL.
    }
  }
  return matches;
}

export function terminalLinkAtBufferCell(terminal: Terminal, column: number, row: number): TerminalLinkMatch | null {
  const line = terminal.buffer.active.getLine(row);
  if (!line) return null;
  return findTerminalLinkMatches(line.translateToString(true))
    .find((match) => column >= match.start && column < match.end) ?? null;
}

export function openTerminalUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  window.open(url.href, "_blank", "noopener,noreferrer");
}

export function registerTerminalLinkProvider(terminal: Terminal): IDisposable {
  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber);
      if (!line) {
        callback(undefined);
        return;
      }
      const links = findTerminalLinkMatches(line.translateToString(true)).map((match) => ({
        range: {
          start: { x: match.start + 1, y: bufferLineNumber + 1 },
          end: { x: match.end + 1, y: bufferLineNumber + 1 },
        },
        text: match.text,
        decorations: { underline: true, pointerCursor: true },
        activate: () => openTerminalUrl(match.url),
      }));
      callback(links);
    },
  });
}
