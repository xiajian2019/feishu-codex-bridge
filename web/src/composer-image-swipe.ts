/** A deliberate horizontal swipe changes images; short or mostly vertical gestures do not. */
export function imageSwipeDirection(deltaX: number, deltaY: number): -1 | 1 | null {
  if (Math.abs(deltaX) < 50 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return null;
  return deltaX < 0 ? 1 : -1;
}
