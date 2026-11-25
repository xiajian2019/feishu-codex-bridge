import { describe, expect, it } from "bun:test";
import { createComposerImeGuard } from "../web/src/composer-ime.js";

function key(timeStamp: number, options: Partial<Pick<KeyboardEvent, "key" | "keyCode" | "isComposing">> = {}) {
  return { key: "Enter", keyCode: 13, isComposing: false, timeStamp, ...options };
}

describe("Composer IME Enter guard", () => {
  it("recognizes active composition even if the key event loses its flag", () => {
    const guard = createComposerImeGuard();
    expect(guard.isImeEnter(key(10, { isComposing: true }))).toBe(true);
    guard.start();
    expect(guard.isImeEnter(key(20))).toBe(true);
    expect(guard.isImeEnter(key(20, { key: "ArrowDown", keyCode: 229 }))).toBe(false);
  });

  it("protects delayed and out-of-order composition confirmation", () => {
    const guard = createComposerImeGuard();
    guard.start();
    guard.end(100);
    expect(guard.isImeEnter(key(200, { keyCode: 229 }))).toBe(true);
    expect(guard.isImeEnter(key(99))).toBe(true);
    expect(guard.isImeEnter(key(120))).toBe(true);
    expect(guard.isImeEnter(key(150))).toBe(false);
    expect(guard.isImeEnter(key(500))).toBe(false);
  });

  it("lets normal Enter work initially and after a focus reset", () => {
    const guard = createComposerImeGuard();
    expect(guard.isImeEnter(key(1))).toBe(false);
    guard.start();
    guard.reset();
    expect(guard.isImeEnter(key(2))).toBe(false);
  });
});
