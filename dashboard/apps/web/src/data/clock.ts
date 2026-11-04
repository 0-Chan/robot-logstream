// Playhead estimation between 10 Hz server clock messages.

export interface ClockState {
  t: number;
  playing: boolean;
  speed: number;
  /** performance.now() when `t` was set (server clock message or local seek). */
  receivedAt: number;
}

/**
 * Current playhead. Extrapolates only while playing AND connected: after a disconnect the playhead
 * stays where it was, so panels never scroll past data that will not arrive.
 */
export function estimate(clock: ClockState, now: number, connected: boolean, t1: number): number {
  if (!clock.playing || !connected) return clock.t;
  return Math.min(clock.t + ((now - clock.receivedAt) / 1000) * clock.speed, t1);
}

/** Freeze at the current estimate (call when the connection drops, before marking it closed). */
export function freeze<C extends ClockState>(clock: C, now: number, t1: number): C {
  return { ...clock, t: estimate(clock, now, true, t1), receivedAt: now };
}

/** Optimistic local seek: the playhead jumps immediately instead of waiting for the server clock. */
export function seekTo<C extends ClockState>(clock: C, t: number, now: number): C {
  return { ...clock, t, receivedAt: now };
}
