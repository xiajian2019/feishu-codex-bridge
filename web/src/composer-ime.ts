// Some macOS input methods deliver compositionend before their confirming Enter.
// Keep the narrow timestamp fallback for cases that also report keyCode 13.
const COMPOSITION_END_WINDOW_MS = 50;

type ComposerKeyEvent = Pick<KeyboardEvent, "key" | "keyCode" | "isComposing" | "timeStamp">;

export function createComposerImeGuard() {
  let composing = false;
  let compositionEndedAt: number | null = null;
  return {
    start(): void {
      composing = true;
      compositionEndedAt = null;
    },
    end(timeStamp: number): void {
      composing = false;
      compositionEndedAt = timeStamp;
    },
    reset(): void {
      composing = false;
      compositionEndedAt = null;
    },
    isImeEnter(event: ComposerKeyEvent): boolean {
      if (event.key !== "Enter") return false;
      return event.isComposing || event.keyCode === 229 || composing
        || (compositionEndedAt !== null
          && Math.abs(event.timeStamp - compositionEndedAt) < COMPOSITION_END_WINDOW_MS);
    },
  };
}
