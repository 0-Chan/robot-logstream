import { describe, expect, it } from "vitest";
import { Gate } from "./gate.ts";

describe("Gate", () => {
  it("accepts current socket + epoch and increasing time per topic", () => {
    const g = new Gate();
    const s = g.newSocket();
    expect(g.commit(s, 0, 1, 10)).toBe(true);
    expect(g.commit(s, 0, 1, 10.1)).toBe(true);
    expect(g.commit(s, 0, 2, 5)).toBe(true); // other topic has its own order
  });

  it("drops older or duplicate samples of the same topic (out-of-order decodes)", () => {
    const g = new Gate();
    const s = g.newSocket();
    g.commit(s, 0, 1, 10.2);
    expect(g.commit(s, 0, 1, 10.1)).toBe(false);
    expect(g.commit(s, 0, 1, 10.2)).toBe(false);
  });

  it("rejects everything from before a seek, even if it was admitted before decoding", () => {
    const g = new Gate();
    const s = g.newSocket();
    expect(g.admits(s, 0, 1, 50)).toBe(true); // decode starts
    const e = g.nextEpoch(); // user seeks while decoding
    expect(g.commit(s, 0, 1, 50)).toBe(false); // decode finishes: must be dropped
    expect(g.commit(s, e, 1, 5)).toBe(true); // new position may go back in time
  });

  it("rejects messages from an old socket after reconnecting", () => {
    const g = new Gate();
    const old = g.newSocket();
    const cur = g.newSocket();
    expect(g.commit(old, 0, 1, 1)).toBe(false);
    expect(g.commit(cur, 0, 1, 1)).toBe(true);
  });

  it("keeps the epoch monotonic across sockets so a new session cannot replay old epochs", () => {
    const g = new Gate();
    g.newSocket();
    g.nextEpoch();
    g.nextEpoch();
    const s = g.newSocket();
    expect(g.epoch).toBe(2);
    expect(g.commit(s, 0, 1, 1)).toBe(false); // server's initial epoch 0 is not ours anymore
  });
});
