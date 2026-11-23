export interface RemoteDesktopKeySender {
  sendKey(keysym: number, code?: string | null, down?: boolean): void;
}

export interface RemoteDesktopShortcut {
  modifierKeysym: number;
  modifierCode: string;
  keysym: number;
  code: string;
}

// macOS Screen Sharing interprets Super_L as the Command key over RFB.
export const COMMAND_KEY = { keysym: 0xffeb, code: "MetaLeft" } as const;

export const REMOTE_DESKTOP_SHORTCUTS = {
  switchApp: { modifierKeysym: COMMAND_KEY.keysym, modifierCode: COMMAND_KEY.code, keysym: 0xff09, code: "Tab" },
  spotlight: { modifierKeysym: COMMAND_KEY.keysym, modifierCode: COMMAND_KEY.code, keysym: 0x20, code: "Space" },
  switchWindow: { modifierKeysym: COMMAND_KEY.keysym, modifierCode: COMMAND_KEY.code, keysym: 0x60, code: "Backquote" },
  missionControl: { modifierKeysym: 0xffe3, modifierCode: "ControlLeft", keysym: 0xff52, code: "ArrowUp" },
} as const satisfies Record<string, RemoteDesktopShortcut>;

/** Send a complete modifier shortcut while guaranteeing the modifier is released. */
export function sendRemoteDesktopShortcut(client: RemoteDesktopKeySender, shortcut: RemoteDesktopShortcut): void {
  client.sendKey(shortcut.modifierKeysym, shortcut.modifierCode, true);
  try {
    client.sendKey(shortcut.keysym, shortcut.code, true);
    client.sendKey(shortcut.keysym, shortcut.code, false);
  } finally {
    client.sendKey(shortcut.modifierKeysym, shortcut.modifierCode, false);
  }
}
