import { describe, expect, it } from "vitest";
import { decimate, indexAtOrBefore } from "./store.ts";

describe("indexAtOrBefore", () => {
  const ts = new Float64Array([1, 2, 2, 3, 5]);
  it("returns the last index at or before t", () => {
    expect(indexAtOrBefore(ts, 0.5)).toBe(-1);
    expect(indexAtOrBefore(ts, 1)).toBe(0);
    expect(indexAtOrBefore(ts, 2)).toBe(2);
    expect(indexAtOrBefore(ts, 4.9)).toBe(3);
    expect(indexAtOrBefore(ts, 99)).toBe(4);
  });
  it("handles empty arrays", () => {
    expect(indexAtOrBefore(new Float64Array(0), 1)).toBe(-1);
  });
});

describe("decimate", () => {
  // 400 Hz for 1 s
  const ts = Float64Array.from({ length: 400 }, (_, i) => 1000 + i / 400);
  it("limits the rate to maxHz", () => {
    const idx = decimate(ts, 0, ts.length, 100);
    expect(idx.length).toBe(100);
    expect(idx[0]).toBe(0);
  });
  it("stays at maxHz when called in many small windows (as the 20 ms tick does)", () => {
    const idx: number[] = [];
    for (let a = 0; a < 400; a += 7) idx.push(...decimate(ts, a, Math.min(a + 7, 400), 100));
    expect(idx).toEqual(decimate(ts, 0, 400, 100));
  });
  it("keeps everything when maxHz is above the source rate or 0", () => {
    expect(decimate(ts, 0, 400, 1000).length).toBe(400);
    expect(decimate(ts, 0, 400, 0).length).toBe(400);
  });
  it("is stable across window boundaries", () => {
    const whole = decimate(ts, 0, 400, 50);
    const split = [...decimate(ts, 0, 200, 50), ...decimate(ts, 200, 400, 50)];
    expect(split).toEqual(whole);
  });
  it("returns nothing for empty ranges", () => {
    expect(decimate(ts, 10, 10, 50)).toEqual([]);
  });
});
