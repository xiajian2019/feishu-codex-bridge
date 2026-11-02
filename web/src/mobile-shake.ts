interface Acceleration { x: number; y: number; z: number }

// DeviceMotion reports acceleration in m/s². Require two strong, sustained
// movements; a short impact or a return to rest should not open the dialog.
const SHAKE_ACCELERATION = 12;
const MIN_BURST_MS = 60;
const MAX_CROSSING_LOOKBACK_MS = 20;
const MIN_SHAKE_INTERVAL_MS = 180;
const DOUBLE_SHAKE_WINDOW_MS = 1_800;
const SAMPLE_GAP_MS = 500;
const COOLDOWN_MS = 1_500;
const BASELINE_TIME_CONSTANT_MS = 600;
const MAX_BASELINE_DELTA = 4;

/** Recognize two sustained, opposing motions without requiring a pause. */
export function createShakeDetector(): {
  sample: (acceleration: Acceleration, now: number) => boolean;
  reset: () => void;
} {
  let baseline: Acceleration | null = null;
  let lastSampleAt: number | null = null;
  let previousChange: Acceleration | null = null;
  let burst: (Acceleration & { startedAt: number; counted: boolean }) | null = null;
  let firstShake: (Acceleration & { at: number }) | null = null;
  let cooldownUntil = -Infinity;

  const reset = (): void => {
    baseline = null;
    lastSampleAt = null;
    previousChange = null;
    burst = null;
    firstShake = null;
  };

  const sample = (acceleration: Acceleration, now: number): boolean => {
    if (![acceleration.x, acceleration.y, acceleration.z, now].every(Number.isFinite)) {
      reset();
      return false;
    }
    if (lastSampleAt !== null && (now <= lastSampleAt || now - lastSampleAt > SAMPLE_GAP_MS)) reset();
    if (!baseline || lastSampleAt === null) {
      baseline = { ...acceleration };
      lastSampleAt = now;
      previousChange = { x: 0, y: 0, z: 0 };
      return false;
    }

    const elapsed = now - lastSampleAt;
    lastSampleAt = now;
    const change = { x: acceleration.x - baseline.x, y: acceleration.y - baseline.y, z: acceleration.z - baseline.z };
    const magnitude = Math.hypot(change.x, change.y, change.z);
    const previous = previousChange;
    previousChange = change;
    // Follow gravity and gradual orientation changes, but don't let a hard
    // impact drag the baseline far enough to turn its release into a shake.
    const baselineWeight = (1 - Math.exp(-elapsed / BASELINE_TIME_CONSTANT_MS)) *
      (magnitude > MAX_BASELINE_DELTA ? MAX_BASELINE_DELTA / magnitude : 1);
    baseline = {
      x: baseline.x + change.x * baselineWeight,
      y: baseline.y + change.y * baselineWeight,
      z: baseline.z + change.z * baselineWeight,
    };

    if (now < cooldownUntil) return false;
    if (firstShake && now - firstShake.at > DOUBLE_SHAKE_WINDOW_MS) firstShake = null;
    if (magnitude < SHAKE_ACCELERATION) {
      burst = null;
      return false;
    }

    const direction = { x: change.x / magnitude, y: change.y / magnitude, z: change.z / magnitude };
    const burstAlignment = burst && direction.x * burst.x + direction.y * burst.y + direction.z * burst.z;
    if (!burst || burstAlignment === null || burstAlignment < 0.5) {
      // Estimate the threshold crossing between samples so slower sensors do
      // not need an extra entire sampling interval to qualify a sustained burst.
      // Cap the estimate so a delayed sample cannot turn a brief impact into a long burst.
      const previousAlongDirection = previous ? previous.x * direction.x + previous.y * direction.y + previous.z * direction.z : magnitude;
      const crossing = previousAlongDirection < SHAKE_ACCELERATION
        ? elapsed * (magnitude - SHAKE_ACCELERATION) / (magnitude - previousAlongDirection)
        : 0;
      burst = { ...direction, startedAt: now - Math.min(crossing, MAX_CROSSING_LOOKBACK_MS), counted: false };
      return false;
    }
    if (burst.counted || now - burst.startedAt < MIN_BURST_MS) return false;
    if (!firstShake) {
      burst.counted = true;
      firstShake = { ...direction, at: now };
      return false;
    }
    const alignment = direction.x * firstShake.x + direction.y * firstShake.y + direction.z * firstShake.z;
    if (alignment > -0.5) {
      burst.counted = true;
      return false;
    }
    if (now - firstShake.at < MIN_SHAKE_INTERVAL_MS) return false;

    burst = null;
    firstShake = null;
    cooldownUntil = now + COOLDOWN_MS;
    return true;
  };

  return { sample, reset };
}
