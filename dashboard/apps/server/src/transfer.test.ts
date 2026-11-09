import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GB, TransferMeter, levelsUpTo, loadTransferState, saveTransferState, type TransferAlert } from "./transfer.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function meter(start = Date.UTC(2026, 10, 11, 12), saved = null as ReturnType<TransferMeter["toJSON"]> | null) {
  let now = start;
  const m = new TransferMeter(
    { allowanceBytes: 100 * GB, spikeBytesPerHour: 10 * GB, overageUsdPerGb: 0.13, now: () => now },
    saved,
  );
  return { m, advance: (ms: number) => (now += ms), set: (t: number) => (now = t) };
}

const monthly = (alerts: TransferAlert[]) => alerts.filter((a) => a.kind === "monthly").map((a) => (a as { level: number }).level);

describe("TransferMeter", () => {
  it("alerts each monthly level once, in order", () => {
    const { m, advance } = meter();
    m.add(49 * GB);
    expect(monthly(m.check())).toEqual([]);
    advance(2 * HOUR);
    m.add(2 * GB); // 51 %
    expect(monthly(m.check())).toEqual([50]);
    expect(monthly(m.check())).toEqual([]);
    advance(2 * HOUR);
    m.add(30 * GB); // 81 %
    expect(monthly(m.check())).toEqual([80]);
  });

  it("reports only the highest level when several are crossed at once", () => {
    const { m } = meter();
    m.add(97 * GB);
    expect(monthly(m.check())).toEqual([95]);
    expect(m.toJSON().alerted.sort((a, b) => a - b)).toEqual([50, 80, 95]);
  });

  it("keeps alerting every 10 points above the allowance", () => {
    expect(levelsUpTo(131)).toEqual([50, 80, 95, 100, 110, 120, 130]);
    const { m, advance } = meter();
    m.add(100 * GB);
    expect(monthly(m.check())).toEqual([100]);
    advance(2 * HOUR);
    m.add(12 * GB);
    expect(monthly(m.check())).toEqual([110]);
  });

  it("starts over in a new month", () => {
    const { m, set } = meter(Date.UTC(2026, 10, 30, 23));
    m.add(90 * GB);
    m.check();
    set(Date.UTC(2026, 11, 1, 0, 5));
    expect(m.usage()).toMatchObject({ month: "2026-12", sentGB: 0 });
    m.add(1 * GB);
    expect(monthly(m.check())).toEqual([]);
  });

  it("does not repeat alerts after a restart, and keeps the count", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "transfer-")), "state.json");
    const a = meter();
    a.m.add(85 * GB);
    a.m.check();
    await saveTransferState(file, a.m.toJSON());

    const b = meter(Date.UTC(2026, 10, 11, 13), await loadTransferState(file));
    expect(b.m.usage().sentGB).toBe(85);
    expect(monthly(b.m.check())).toEqual([]);
  });

  it("ignores a saved state from another month", () => {
    const { m } = meter(Date.UTC(2026, 11, 2), { month: "2026-11", bytes: 99 * GB, alerted: [50, 80, 95], lastSpikeAt: null });
    expect(m.usage().sentGB).toBe(0);
  });

  it("detects a spike in the last hour and repeats it at most every 6 hours", () => {
    const { m, advance } = meter();
    m.add(11 * GB);
    expect(m.check().some((a) => a.kind === "spike")).toBe(true);
    advance(30 * 60_000);
    m.add(11 * GB);
    expect(m.check().some((a) => a.kind === "spike")).toBe(false);
    advance(6 * HOUR);
    m.add(11 * GB);
    expect(m.check().some((a) => a.kind === "spike")).toBe(true);
  });

  it("forgets transfer older than an hour for the spike window", () => {
    const { m, advance } = meter();
    m.add(5 * GB);
    advance(61 * 60_000);
    m.add(1 * GB);
    expect(m.usage().lastHourGB).toBe(1);
  });

  it("projects the month-end usage from the pace so far (not on the first day)", () => {
    const first = meter(Date.UTC(2026, 10, 1, 12));
    first.m.add(10 * GB);
    expect(first.m.usage().projectedGB).toBeNull();

    const mid = meter(Date.UTC(2026, 10, 1) + 10 * DAY); // 10 of 30 days
    mid.m.add(50 * GB);
    const u = mid.m.usage();
    expect(u.projectedGB).toBeCloseTo(150, 3);
    expect(u.projectedOverageUsd).toBeCloseTo(50 * 0.13, 2);
  });
});
