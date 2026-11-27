export interface RemoteDesktopTextKeyEvent {
  keysym: number;
  code?: string;
}

function keysymForCharacter(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return 0x01000000 | code;
}

/** Convert submitted text into ordered RFB key presses without involving a DOM input. */
export function remoteDesktopTextKeyEvents(value: string, appendEnter = false): RemoteDesktopTextKeyEvent[] {
  const events: RemoteDesktopTextKeyEvent[] = [];
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character === "\r") {
      if (value[index + 1] === "\n") index += 1;
      events.push({ keysym: 0xff0d, code: "Enter" });
      index += 1;
    } else if (character === "\n") {
      events.push({ keysym: 0xff0d, code: "Enter" });
      index += 1;
    } else if (character === "\t") {
      events.push({ keysym: 0xff09, code: "Tab" });
      index += 1;
    } else {
      const codePoint = value.codePointAt(index) ?? 0;
      events.push({ keysym: keysymForCharacter(String.fromCodePoint(codePoint)) });
      index += codePoint > 0xffff ? 2 : 1;
    }
  }
  if (appendEnter) events.push({ keysym: 0xff0d, code: "Enter" });
  return events;
}
