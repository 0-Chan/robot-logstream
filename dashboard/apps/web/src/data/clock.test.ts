import { describe, expect, it } from "vitest";
import { estimate, freeze, seekTo } from "./clock.ts";

const playing = { t: 100, playing: true, speed: 2, receivedAt: 1000 };

describe("playback clock", () => {
  it("extrapolates while playing and connected", () => {
    expect(estimate(playing, 1500, true, 999)).toBeCloseTo(101); // 0.5 s wall × speed 2
  });

  it("does not advance while disconnected", () => {
    expect(estimate(playing, 5000, false, 999)).toBe(100);
  });

  it("clamps at the end of the sequence", () => {
    expect(estimate(playing, 100000, true, 120)).toBe(120);
  });

  it("freeze keeps the position reached at the moment of the disconnect", () => {
    const f = freeze(playing, 1500, 999);
    expect(f.t).toBeCloseTo(101);
    expect(estimate(f, 9999, false, 999)).toBeCloseTo(101);
  });

  it("a local seek moves the playhead immediately and keeps extra fields", () => {
    const c = seekTo({ ...playing, epoch: 4 }, 50, 2000);
    expect(c.t).toBe(50);
    expect(c.epoch).toBe(4);
    expect(estimate(c, 2000, true, 999)).toBe(50);
  });
});
