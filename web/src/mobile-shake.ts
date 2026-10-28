interface Acceleration { x: number; y: number; z: number }

const SHAKE_THRESHOLD = 8.5;
const LOOKBACK_MS = 80;
const MIN_SHAKE_INTERVAL_MS = 160;
const DOUBLE_SHAKE_WINDOW_MS = 1_800;
const SAMPLE_GAP_MS = 500;
const COOLDOWN_MS = 1_500;

/** Recognize two opposing motion bursts without requiring a pause between them. */
export function createShakeDetector(): {
  sample: (acceleration: Acceleration, now: number) => boolean;
  reset: () => void;
} {
  const samples: Array<Acceleration & { at: number }> = [];
  let firstShake: (Acceleration & { at: number }) | null = null;
  let cooldownUntil = -Infinity;

  const reset = (): void => {
    samples.length = 0;
    firstShake = null;
  };

  const sample = (acceleration: Acceleration, now: number): boolean => {
    if (![acceleration.x, acceleration.y, acceleration.z, now].every(Number.isFinite)) {
      reset();
      return false;
    }
    const previous = samples.at(-1);
    if (previous && (now <= previous.at || now - previous.at > SAMPLE_GAP_MS)) reset();
    samples.push({ ...acceleration, at: now });
    // Compare over a fixed time span: adjacent-frame deltas get smaller as the
    // sensor sampling rate increases, even for an identical physical motion.
    while (samples.length > 1 && now - samples[1]!.at >= LOOKBACK_MS) samples.shift();
    const before = samples[0]!;
    if (now - before.at < LOOKBACK_MS || now < cooldownUntil) return false;
    if (firstShake && now - firstShake.at > DOUBLE_SHAKE_WINDOW_MS) firstShake = null;

    const change = { x: acceleration.x - before.x, y: acceleration.y - before.y, z: acceleration.z - before.z };
    const delta = Math.hypot(change.x, change.y, change.z);
    if (delta < SHAKE_THRESHOLD) return false;
    const direction = { x: change.x / delta, y: change.y / delta, z: change.z / delta };
    if (!firstShake) {
      firstShake = { ...direction, at: now };
      return false;
    }
    if (now - firstShake.at < MIN_SHAKE_INTERVAL_MS) return false;
    // Repeated readings in the same direction count once. A reversal, rather
    // than a mandatory still period, lets a natural continuous shake qualify.
    const alignment = direction.x * firstShake.x + direction.y * firstShake.y + direction.z * firstShake.z;
    if (alignment > -0.25) return false;
    reset();
    cooldownUntil = now + COOLDOWN_MS;
    return true;
  };

  return { sample, reset };
}
