// The single rule every renderer uses to decide whether a sample may be shown at the playhead.

export type SampleState = "ok" | "stale" | "future" | "none" | "disconnected";

export interface SelectOptions {
  /** Nominal sensor rate, used for the staleness threshold. */
  hz: number | null;
  connected: boolean;
  /** Older than this (s) is "stale". Default max(3 periods, 0.3 s). */
  maxAge?: number;
  /** Older than this (s) is not shown at all. */
  hardLimit?: number;
}

export interface Selection {
  state: SampleState;
  /** playhead - sample time, in seconds (NaN when there is no sample). */
  age: number;
}

/** Tolerance for float rounding between the server clock and sample timestamps. */
export const EPSILON_S = 0.002;
export const HARD_LIMIT_S = 2;

export function maxAgeFor(hz: number | null): number {
  return Math.max(0.3, hz ? 3 / hz : 0.3);
}

export function selectSample(sampleT: number | undefined, playhead: number, opts: SelectOptions): Selection {
  const age = sampleT === undefined ? NaN : playhead - sampleT;
  // Connection lost: renderers keep the last frame but must mark it; nothing new is coming.
  if (!opts.connected) return { state: "disconnected", age };
  if (sampleT === undefined) return { state: "none", age };
  // Never show data from after the playhead (e.g. a frame left over from before a backward seek).
  if (age < -EPSILON_S) return { state: "future", age };
  if (age > (opts.hardLimit ?? HARD_LIMIT_S)) return { state: "none", age };
  if (age > (opts.maxAge ?? maxAgeFor(opts.hz))) return { state: "stale", age };
  return { state: "ok", age };
}

/** Whether a state allows drawing the sample (disconnected: only as a marked, frozen last frame). */
export const isDrawable = (s: SampleState) => s === "ok" || s === "stale" || s === "disconnected";
