/** Temporarily reveal the App connection center without terminating an SSH session. */
export function createMobileWorkspaceOverlay(operations: {
  hide: () => Promise<boolean>;
  show: () => Promise<unknown>;
  close: () => Promise<void>;
}) {
  let suspended = false;
  let opening = false;
  let interrupted: "restore" | "close" | null = null;

  return {
    async open(): Promise<boolean> {
      if (opening || suspended) return false;
      opening = true;
      interrupted = null;
      try {
        const hidden = await operations.hide().catch(() => false);
        if (interrupted) {
          if (hidden) {
            if (interrupted === "close") await operations.close();
            else await operations.show();
          }
          return false;
        }
        suspended = hidden;
        return true;
      } finally {
        opening = false;
      }
    },
    async dismiss(): Promise<void> {
      if (opening) interrupted = "restore";
      if (suspended) {
        await operations.show();
        suspended = false;
      }
    },
    async leave(): Promise<void> {
      if (opening) interrupted = "close";
      if (suspended) {
        await operations.close();
        suspended = false;
      }
    },
  };
}
