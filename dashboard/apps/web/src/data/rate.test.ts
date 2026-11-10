import { describe, expect, it } from "vitest";
import { RateMeter } from "./rate.ts";

describe("RateMeter", () => {
  it("counts frames drawn in the last second", () => {
    const m = new RateMeter();
    for (let i = 0; i < 30; i++) m.tick(i * 100); // 10 Hz for 3 s
    expect(m.rate(2950)).toBe(10);
  });

  it("drops to 0 a second after frames stop", () => {
    const m = new RateMeter();
    for (let i = 0; i < 10; i++) m.tick(i * 100);
    expect(m.rate(950)).toBe(10);
    expect(m.rate(1950)).toBe(0);
  });

  it("is 0 after reset", () => {
    const m = new RateMeter();
    m.tick(0);
    m.tick(50);
    m.reset();
    expect(m.rate(100)).toBe(0);
  });
});
