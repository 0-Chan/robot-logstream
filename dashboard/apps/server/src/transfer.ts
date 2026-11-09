// Monthly outbound transfer meter. Counts what this server sends (WebSocket + HTTP), raises alerts as
// the month's usage crosses the plan's included transfer, and never blocks playback.
import { readFile, rename, writeFile } from "node:fs/promises";

export const GB = 1e9;
/** Percent of the allowance at which to alert; above 100 % every further 10 points. */
export const MONTHLY_LEVELS = [50, 80, 95, 100];
const OVER_STEP = 10;
const SPIKE_REPEAT_MS = 6 * 3600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface TransferOptions {
  allowanceBytes: number;
  spikeBytesPerHour: number;
  overageUsdPerGb: number;
  now?: () => number;
}

/** What survives a restart. */
export interface TransferState {
  month: string;
  bytes: number;
  /** Monthly levels (percent) already alerted this month. */
  alerted: number[];
  lastSpikeAt: number | null;
}

export interface TransferUsage {
  month: string;
  sentGB: number;
  allowanceGB: number;
  percent: number;
  lastHourGB: number;
  /** Month-end estimate from the pace so far; null during the first day (too noisy). */
  projectedGB: number | null;
  /** Cost of the projected usage above the allowance (0 when it fits). */
  projectedOverageUsd: number | null;
  resetsAt: string;
}

export type TransferAlert =
  | { kind: "monthly"; level: number; usage: TransferUsage }
  | { kind: "spike"; usage: TransferUsage }
  | { kind: "test"; usage: TransferUsage };

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const monthStart = (ms: number) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), 1);
const nextMonthStart = (ms: number) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth() + 1, 1);

export class TransferMeter {
  private readonly now: () => number;
  private state: TransferState;
  /** Bytes per minute for the last hour: [minute index, bytes]. */
  private minutes: [number, number][] = [];

  constructor(
    private readonly opts: TransferOptions,
    saved?: TransferState | null,
  ) {
    this.now = opts.now ?? Date.now;
    const month = monthOf(this.now());
    this.state = saved && saved.month === month ? { ...saved, alerted: [...saved.alerted] } : fresh(month);
  }

  add(bytes: number) {
    const t = this.now();
    this.rollMonth(t);
    this.state.bytes += bytes;
    const minute = Math.floor(t / MINUTE_MS);
    const last = this.minutes[this.minutes.length - 1];
    if (last && last[0] === minute) last[1] += bytes;
    else this.minutes.push([minute, bytes]);
    while (this.minutes.length && this.minutes[0][0] <= minute - 60) this.minutes.shift();
  }

  usage(): TransferUsage {
    const t = this.now();
    this.rollMonth(t);
    const { allowanceBytes, overageUsdPerGb } = this.opts;
    const start = monthStart(t);
    const end = nextMonthStart(t);
    const elapsed = t - start;
    const projected = elapsed >= DAY_MS ? (this.state.bytes * (end - start)) / elapsed : null;
    const minute = Math.floor(t / MINUTE_MS);
    const lastHour = this.minutes.filter(([m]) => m > minute - 60).reduce((s, [, b]) => s + b, 0);
    return {
      month: this.state.month,
      sentGB: round(this.state.bytes / GB),
      allowanceGB: round(allowanceBytes / GB),
      percent: round((100 * this.state.bytes) / allowanceBytes, 1),
      lastHourGB: round(lastHour / GB),
      projectedGB: projected === null ? null : round(projected / GB),
      projectedOverageUsd:
        projected === null ? null : round((Math.max(0, projected - allowanceBytes) / GB) * overageUsdPerGb, 2),
      resetsAt: new Date(end).toISOString(),
    };
  }

  /** New alerts since the last check; each is recorded so it is raised only once. */
  check(): TransferAlert[] {
    const usage = this.usage();
    const alerts: TransferAlert[] = [];
    const due = levelsUpTo(usage.percent).filter((l) => !this.state.alerted.includes(l));
    if (due.length) {
      // Several levels at once (e.g. first check after a restart): report only the highest.
      this.state.alerted.push(...due);
      alerts.push({ kind: "monthly", level: Math.max(...due), usage });
    }
    const t = this.now();
    const spike = usage.lastHourGB * GB > this.opts.spikeBytesPerHour;
    if (spike && (this.state.lastSpikeAt === null || t - this.state.lastSpikeAt >= SPIKE_REPEAT_MS)) {
      this.state.lastSpikeAt = t;
      alerts.push({ kind: "spike", usage });
    }
    return alerts;
  }

  toJSON(): TransferState {
    return { ...this.state, alerted: [...this.state.alerted] };
  }

  private rollMonth(t: number) {
    const month = monthOf(t);
    if (month !== this.state.month) this.state = fresh(month);
  }
}

/** Alert levels reached at `percent`: the fixed ones, then every OVER_STEP above 100. */
export function levelsUpTo(percent: number): number[] {
  const levels = MONTHLY_LEVELS.filter((l) => percent >= l);
  for (let l = 100 + OVER_STEP; l <= percent; l += OVER_STEP) levels.push(l);
  return levels;
}

const fresh = (month: string): TransferState => ({ month, bytes: 0, alerted: [], lastSpikeAt: null });
const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;

export async function loadTransferState(file: string): Promise<TransferState | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as TransferState;
  } catch {
    return null; // first start, or unreadable: start counting from zero
  }
}

export async function saveTransferState(file: string, state: TransferState) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}
