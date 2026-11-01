import { describe, expect, it } from "bun:test";
import { createShakeDetector } from "../web/src/mobile-shake.js";

type Motion = (at: number) => { x: number; y: number; z: number };

function motionTrace(motion: Motion, until: number, interval = 20, detector = createShakeDetector(), start = 0): number[] {
  const triggered: number[] = [];
  for (let at = start; at <= until; at += interval) {
    if (detector.sample(motion(at), at)) triggered.push(at);
  }
  return triggered;
}

function pulses(changes: Array<[number, number]>, gravity = 9.81): Motion {
  return (at) => ({ x: changes.findLast(([time]) => time <= at)?.[1] ?? 0, y: 0, z: gravity });
}

describe("mobile double-shake detection", () => {
  it("ignores ordinary movement and repeated small shakes", () => {
    expect(motionTrace(pulses([[100, 3], [140, 0], [300, -3], [340, 0]]), 1_600)).toEqual([]);
    const gentle: Motion = (at) => ({ x: 9 * Math.sin(2 * Math.PI * 2.5 * at / 1_000), y: 0, z: 9.81 });
    expect(motionTrace(gentle, 4_000)).toEqual([]);
  });

  it("does not mistake a single sustained movement and its return to rest for two shakes", () => {
    expect(motionTrace(pulses([[100, 25], [360, 0]]), 1_600)).toEqual([]);
    expect(motionTrace(pulses([[100, 25], [200, 0], [500, 25], [600, 0]]), 1_600)).toEqual([]);
  });

  it("ignores a strong brief impact and the short rebound from putting a phone on a table", () => {
    const tableImpact = pulses([[200, 45], [280, -45], [320, 18], [340, -8], [360, 0]]);
    expect(motionTrace(tableImpact, 1_600)).toEqual([]);
  });

  it("does not stretch brief impacts into sustained motion after delayed sensor samples", () => {
    const detector = createShakeDetector();
    const samples: Array<[number, number]> = [[0, 0], [400, 45], [420, 45], [440, 0], [600, 0], [800, -45], [820, -45], [840, 0]];
    expect(samples.map(([at, x]) => detector.sample({ x, y: 0, z: 9.81 }, at))).not.toContain(true);
  });

  it("opens only after two sustained opposing strong movements", () => {
    const doubleShake = pulses([[100, 22], [220, 0], [500, -22], [620, 0]]);
    expect(motionTrace(doubleShake, 1_600)).toEqual([560]);
  });

  it("does not combine shakes outside the time window", () => {
    const isolated = pulses([[100, 22], [220, 0], [2_100, -22], [2_220, 0]]);
    expect(motionTrace(isolated, 2_400)).toEqual([]);
  });

  for (const interval of [8, 16, 20, 40]) {
    it(`recognizes two large continuous shakes at a ${interval} ms sampling interval`, () => {
      const large: Motion = (at) => ({ x: 20 * Math.sin(2 * Math.PI * 2.5 * at / 1_000), y: 0, z: 9.81 });
      const triggered = motionTrace(large, 1_000, interval);
      expect(triggered).toHaveLength(1);
      expect(triggered[0]).toBeLessThan(750);
    });
  }

  it("recognizes a large shake regardless of its phase relative to a slower sensor", () => {
    for (let offset = 0; offset < 40; offset++) {
      const start = 300 + offset;
      const motion: Motion = (at) => ({ x: at < start ? 0 : 18 * Math.sin(2 * Math.PI * 2.5 * (at - start) / 1_000), y: 0, z: 9.81 });
      expect(motionTrace(motion, 1_300, 40)).toHaveLength(1);
    }
  });

  it("works along another axis with a constant gravity component", () => {
    const sideways: Motion = (at) => ({ x: 0, y: 20 * Math.sin(2 * Math.PI * 2.5 * at / 1_000), z: -9.81 });
    expect(motionTrace(sideways, 1_000)).toHaveLength(1);
  });

  it("allows a slower deliberate pair of shakes", () => {
    const slow = pulses([[100, 22], [220, 0], [1_600, -22], [1_720, 0]]);
    expect(motionTrace(slow, 1_800)).toEqual([1_660]);
  });

  it("requires a fresh double shake after cooldown", () => {
    const movements: Array<[number, number]> = [100, 500, 900, 1_300, 2_100, 2_500]
      .flatMap((at, index): Array<[number, number]> => [[at, index % 2 ? -22 : 22], [at + 120, 0]]);
    expect(motionTrace(pulses(movements), 2_700)).toEqual([560, 2_560]);
  });

  it("discards the first shake when backgrounding or a sensor gap resets the sequence", () => {
    const detector = createShakeDetector();
    expect(motionTrace(pulses([[100, 22], [220, 0]]), 260, 20, detector)).toEqual([]);
    detector.reset();
    expect(motionTrace(pulses([[500, -22], [620, 0]]), 700, 20, detector, 300)).toEqual([]);
    expect(motionTrace(pulses([[2_000, 22], [2_120, 0]]), 2_200, 20, detector, 1_900)).toEqual([]);
    expect(motionTrace(pulses([[2_400, -22], [2_520, 0]]), 2_600, 20, detector, 2_220)).toEqual([2_460]);
  });

  it("drops invalid readings without leaving a partial shake armed", () => {
    const detector = createShakeDetector();
    motionTrace(pulses([[100, 22], [220, 0]]), 260, 20, detector);
    expect(detector.sample({ x: NaN, y: 0, z: 0 }, 280)).toBe(false);
    expect(motionTrace(pulses([[500, -22], [620, 0]]), 700, 20, detector, 300)).toEqual([]);
  });
});
