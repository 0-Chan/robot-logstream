// Measured display rate: how many new frames a panel drew in the last second of wall-clock time.

const WINDOW_MS = 1000;

export class RateMeter {
  private times: number[] = [];

  /** A new frame was drawn at `now` (performance.now()). */
  tick(now: number) {
    this.times.push(now);
    this.prune(now);
  }

  /** Frames per second over the last window, rounded to an integer. */
  rate(now: number): number {
    this.prune(now);
    return Math.round((this.times.length * 1000) / WINDOW_MS);
  }

  reset() {
    this.times.length = 0;
  }

  private prune(now: number) {
    let drop = 0;
    while (drop < this.times.length && this.times[drop] <= now - WINDOW_MS) drop++;
    if (drop) this.times.splice(0, drop);
  }
}
