import { describe, expect, it } from "bun:test";
import { createShakeDetector } from "../web/src/mobile-shake.js";

function motionTrace(changes: Array<[number, number]>, until: number, detector = createShakeDetector(), start = 0): number[] {
  const triggered: number[] = [];
  let x = 0;
  for (let at = start; at <= until; at += 20) {
    x = changes.findLast(([time]) => time <= at)?.[1] ?? 0;
    // A constant gravity component must not affect the double-shake count.
    if (detector.sample({ x, y: 0, z: 9.81 }, at)) triggered.push(at);
  }
  return triggered;
}

describe("mobile double-shake detection", () => {
  it("ignores normal movement, a single shake, and its multiple acceleration peaks", () => {
    expect(motionTrace([[100, 3], [140, 0], [300, -3], [340, 0]], 1_600)).toEqual([]);
    expect(motionTrace([[100, 25], [120, -25], [140, 25], [160, 0]], 1_600)).toEqual([]);
  });

  it("opens only after two distinct shakes within the double-shake window", () => {
    expect(motionTrace([[100, 25], [140, 0], [500, -25], [540, 0]], 1_600)).toEqual([500]);
  });

  it("does not accumulate isolated shakes or count a single direction twice", () => {
    expect(motionTrace([[100, 25], [140, 0], [2_100, -25], [2_140, 0]], 2_400)).toEqual([]);
    expect(motionTrace([[100, 15], [400, 30], [700, 45]], 1_000)).toEqual([]);
  });

  for (const interval of [8, 16, 20, 40]) {
    it(`recognizes natural continuous shaking without a pause at a ${interval} ms sampling interval`, () => {
      const detector = createShakeDetector();
      const triggered: number[] = [];
      for (let at = 0; at <= 1_000; at += interval) {
        const x = 9 * Math.sin(2 * Math.PI * 2.5 * at / 1_000);
        if (detector.sample({ x, y: 0, z: 9.81 }, at)) triggered.push(at);
      }
      expect(triggered).toHaveLength(1);
      expect(triggered[0]).toBeLessThan(650);
    });
  }

  it("ignores gentle movement even with a long continuous trace", () => {
    const detector = createShakeDetector();
    for (let at = 0; at <= 4_000; at += 20) {
      const x = 2 * Math.sin(2 * Math.PI * 2 * at / 1_000);
      expect(detector.sample({ x, y: 0, z: 9.81 }, at)).toBe(false);
    }
  });

  it("allows a slower deliberate pair of shakes", () => {
    expect(motionTrace([[100, 12], [140, 0], [1_600, -12], [1_640, 0]], 1_800)).toEqual([1_600]);
  });

  it("requires a fresh double shake after cooldown", () => {
    const movements: Array<[number, number]> = [100, 500, 900, 1_300, 2_100, 2_500]
      .flatMap((at, index): Array<[number, number]> => [[at, index % 2 ? -25 : 25], [at + 40, 0]]);
    expect(motionTrace(movements, 2_600)).toEqual([500, 2_500]);
  });

  it("discards the first shake when backgrounding or a sensor gap resets the sequence", () => {
    const detector = createShakeDetector();
    expect(motionTrace([[100, 25], [140, 0]], 200, detector)).toEqual([]);
    detector.reset();
    expect(motionTrace([[500, -25], [540, 0]], 700, detector, 300)).toEqual([]);
    expect(motionTrace([[2_000, 25], [2_040, 0]], 2_200, detector, 1_900)).toEqual([]);
    expect(motionTrace([[2_400, -25], [2_440, 0]], 2_600, detector, 2_220)).toEqual([2_400]);
  });

  it("drops invalid readings without leaving a partial shake armed", () => {
    const detector = createShakeDetector();
    motionTrace([[100, 25], [140, 0]], 200, detector);
    expect(detector.sample({ x: NaN, y: 0, z: 0 }, 220)).toBe(false);
    expect(motionTrace([[500, -25], [540, 0]], 700, detector, 240)).toEqual([]);
  });
});
