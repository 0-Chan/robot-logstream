// Data plane: mutable, non-React store for streamed data. Renderers read it inside
// requestAnimationFrame / useFrame and use `version` counters to skip work when nothing changed.
// Keeping this out of React state avoids re-rendering the tree for every message (hundreds per second).
//
// Every sample carries the epoch it was received in. A seek bumps the epoch and invalidates all
// samples at once, so a panel shows "moving…" / "no data" instead of the previous position's frame.

import { EPSILON_S } from "./select.ts";

export interface PointCloudSnapshot {
  epoch: number;
  t: number;
  n: number;
  positions: Float32Array;
  colors: Uint8Array;
  version: number;
}

export interface ImageSnapshot {
  epoch: number;
  t: number;
  bitmap: ImageBitmap;
  version: number;
}

/** Contiguous growable buffer of the most recent series rows; drops the oldest half when full. */
export class SeriesBuffer {
  ts: Float64Array;
  values: Float32Array;
  length = 0;
  version = 0;

  constructor(
    readonly cols: number,
    private readonly capacity = 20000,
  ) {
    this.ts = new Float64Array(capacity);
    this.values = new Float32Array(capacity * cols);
  }

  push(ts: Float64Array, values: Float32Array) {
    const n = ts.length;
    if (n === 0) return;
    if (n >= this.capacity) {
      this.ts.set(ts.subarray(n - this.capacity));
      this.values.set(values.subarray((n - this.capacity) * this.cols));
      this.length = this.capacity;
    } else {
      if (this.length + n > this.capacity) {
        const keep = Math.min(this.length, Math.floor(this.capacity / 2), this.capacity - n);
        const drop = this.length - keep;
        this.ts.copyWithin(0, drop, this.length);
        this.values.copyWithin(0, drop * this.cols, this.length * this.cols);
        this.length = keep;
      }
      this.ts.set(ts, this.length);
      this.values.set(values, this.length * this.cols);
      this.length += n;
    }
    this.version++;
  }

  clear() {
    this.length = 0;
    this.version++;
  }

  /** Index of the last row with ts <= t, or -1. */
  indexAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ts[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  row(i: number): Float32Array {
    return this.values.subarray(i * this.cols, (i + 1) * this.cols);
  }
}

export const live = {
  pointclouds: new Map<number, PointCloudSnapshot>(),
  images: new Map<number, ImageSnapshot>(),
  series: new Map<number, SeriesBuffer>(),
  /** Current epoch (set by the worker on every seek). Samples from other epochs are never stored. */
  epoch: 0,
  /** performance.now() of the last epoch change, to tell "moving to the new position" from "no data". */
  epochChangedAt: 0,
  /**
   * Display audit for tests: every draw of a frame sample is checked against the invariants
   * (current epoch, not after the playhead). `violations` must stay 0. Exposed as window.__liveAudit.
   */
  audit: { draws: 0, violations: 0 },

  seriesFor(topicId: number, cols: number): SeriesBuffer {
    let b = this.series.get(topicId);
    if (!b || b.cols !== cols) {
      b = new SeriesBuffer(cols);
      this.series.set(topicId, b);
    }
    return b;
  },

  /** A seek happened: drop everything from the previous position right now. */
  setEpoch(epoch: number) {
    this.epoch = epoch;
    this.epochChangedAt = performance.now();
    this.clearSamples();
  },

  /** True shortly after a seek, while the new position's data is still on its way. */
  moving(): boolean {
    return performance.now() - this.epochChangedAt < 1500;
  },

  /** Record a draw of a frame sample and check it against the display invariants. */
  recordDraw(sample: { epoch: number; t: number }, playhead: number) {
    this.audit.draws++;
    if (sample.epoch !== this.epoch || sample.t > playhead + EPSILON_S) this.audit.violations++;
  },

  clearSamples() {
    for (const img of this.images.values()) img.bitmap.close();
    this.pointclouds.clear();
    this.images.clear();
    this.series.clear();
  },

  reset() {
    this.clearSamples();
  },
};

(globalThis as { __liveAudit?: typeof live.audit }).__liveAudit = live.audit;
