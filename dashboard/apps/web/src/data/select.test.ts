import { describe, expect, it } from "vitest";
import { EPSILON_S, HARD_LIMIT_S, isDrawable, maxAgeFor, selectSample } from "./select.ts";

const on = { hz: 10, connected: true };

describe("selectSample", () => {
  it("ok when the sample is at or slightly before the playhead", () => {
    expect(selectSample(100, 100, on).state).toBe("ok");
    expect(selectSample(99.8, 100, on).state).toBe("ok");
  });

  it("never shows samples from after the playhead (beyond float tolerance)", () => {
    expect(selectSample(100 + EPSILON_S / 2, 100, on).state).toBe("ok");
    expect(selectSample(100.01, 100, on).state).toBe("future");
  });

  it("stale between maxAge and the hard limit, none beyond it", () => {
    const maxAge = maxAgeFor(10); // 0.3 s
    expect(selectSample(100 - maxAge - 0.01, 100, on).state).toBe("stale");
    expect(selectSample(100 - HARD_LIMIT_S + 0.01, 100, on).state).toBe("stale");
    expect(selectSample(100 - HARD_LIMIT_S - 0.01, 100, on).state).toBe("none");
  });

  it("scales the staleness threshold with the sensor rate", () => {
    expect(maxAgeFor(1)).toBe(3);
    expect(maxAgeFor(500)).toBe(0.3);
    expect(maxAgeFor(null)).toBe(0.3);
  });

  it("none without a sample", () => {
    const s = selectSample(undefined, 100, on);
    expect(s.state).toBe("none");
    expect(Number.isNaN(s.age)).toBe(true);
  });

  it("disconnected wins over everything, and only then may the last frame stay drawn", () => {
    expect(selectSample(100, 100, { hz: 10, connected: false }).state).toBe("disconnected");
    expect(isDrawable("disconnected")).toBe(true);
    expect(isDrawable("future")).toBe(false);
    expect(isDrawable("none")).toBe(false);
  });
});
