import { describe, expect, it } from "bun:test";
import { imageSwipeDirection } from "../web/src/composer-image-swipe.js";

describe("composer image preview gestures", () => {
  it("moves forward on a left swipe and backward on a right swipe", () => {
    expect(imageSwipeDirection(-80, 10)).toBe(1);
    expect(imageSwipeDirection(80, -10)).toBe(-1);
    expect(imageSwipeDirection(-50, 0)).toBe(1);
  });

  it("ignores short, vertical and ambiguous diagonal movements", () => {
    expect(imageSwipeDirection(49, 0)).toBeNull();
    expect(imageSwipeDirection(-20, 200)).toBeNull();
    expect(imageSwipeDirection(90, 60)).toBeNull();
    expect(imageSwipeDirection(-90, -61)).toBeNull();
  });

  it("accepts a predominantly horizontal diagonal", () => {
    expect(imageSwipeDirection(-90, 59)).toBe(1);
  });
});
