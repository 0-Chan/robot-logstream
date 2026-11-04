import { describe, expect, it } from "vitest";
import { MsgType, decodeData, type Manifest, type ServerMessage } from "@grandtour/protocol";
import { PlaybackSession, type Sink } from "./session.ts";
import type { DataStore, TopicStore } from "./store.ts";

// Minimal in-memory topics: one 10 Hz frame topic, one 100 Hz series topic, over t = 100..110 s.
function fakeData() {
  const frameTs = Float64Array.from({ length: 101 }, (_, i) => 100 + i * 0.1);
  const seriesTs = Float64Array.from({ length: 1001 }, (_, i) => 100 + i * 0.01);
  const frame = {
    meta: { id: 0, name: "cam", kind: "image" },
    ts: frameTs,
    cols: 0,
    readFrame: async (i: number) => new Uint8Array([i & 255]),
  } as unknown as TopicStore;
  const series = {
    meta: { id: 1, name: "imu", kind: "series" },
    ts: seriesTs,
    cols: 1,
    seriesRange: (a: number, b: number) => {
      const idx = [...seriesTs.keys()].filter((i) => seriesTs[i] > a && seriesTs[i] <= b);
      return { ts: Float64Array.from(idx, (i) => seriesTs[i]), values: Float32Array.from(idx, (i) => i) };
    },
  } as unknown as TopicStore;
  const manifest = { t0: 100, t1: 110, topics: [frame.meta, series.meta] } as unknown as Manifest;
  return { manifest, byName: new Map([["cam", frame], ["imu", series]]) } as unknown as DataStore;
}

function harness() {
  const text: ServerMessage[] = [];
  const binary: ReturnType<typeof decodeData>[] = [];
  const sink: Sink = {
    sendText: (s) => text.push(JSON.parse(s)),
    sendBinary: (b) => binary.push(decodeData(b.slice().buffer)),
    bufferedAmount: () => 0,
    isOpen: () => true,
  };
  const session = new PlaybackSession(fakeData(), sink);
  return { session, text, binary };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PlaybackSession (protocol v2)", () => {
  it("sends hello with protocol version 2 and a session id", () => {
    const { session, text } = harness();
    session.start();
    session.stop();
    const hello = text[0];
    expect(hello.op).toBe("hello");
    if (hello.op !== "hello") throw new Error();
    expect(hello.protocolVersion).toBe(2);
    expect(hello.sessionId).toMatch(/[0-9a-f-]{36}/);
  });

  it("stamps data after a seek with the client's epoch and the new position", async () => {
    const { session, binary } = harness();
    session.handle(JSON.stringify({ op: "subscribe", topics: [{ name: "cam" }, { name: "imu" }] }));
    session.handle(JSON.stringify({ op: "seek", t: 105, epoch: 7 }));
    session.tick();
    await flush();
    const frames = binary.filter((m) => m.type === MsgType.Frame);
    const series = binary.filter((m) => m.type === MsgType.SeriesBatch);
    expect(frames.length).toBe(1);
    expect(frames[0].epoch).toBe(7);
    expect(frames[0].t).toBeCloseTo(105, 6);
    expect(series.every((m) => m.epoch === 7 || m.epoch === 0)).toBe(true);
    expect(series.at(-1)!.epoch).toBe(7);
  });

  it("rejects seeks that do not increase the epoch", () => {
    const { session, text } = harness();
    session.handle(JSON.stringify({ op: "seek", t: 105, epoch: 3 }));
    session.handle(JSON.stringify({ op: "seek", t: 101, epoch: 3 }));
    expect(session.epoch).toBe(3);
    expect(session.playhead).toBe(105);
    expect(text.some((m) => m.op === "error")).toBe(true);
  });

  it("drops a frame read that finishes after a newer seek", async () => {
    const { session, binary } = harness();
    session.handle(JSON.stringify({ op: "subscribe", topics: [{ name: "cam" }] }));
    session.handle(JSON.stringify({ op: "seek", t: 102, epoch: 1 }));
    session.tick(); // starts async read of the frame at t=102
    session.handle(JSON.stringify({ op: "seek", t: 108, epoch: 2 })); // before the read resolves
    await flush();
    expect(binary.filter((m) => m.epoch === 1)).toHaveLength(0);
  });

  it("does not rewind on its own when play is requested at the end", () => {
    const { session } = harness();
    session.handle(JSON.stringify({ op: "seek", t: 110, epoch: 1 }));
    session.handle(JSON.stringify({ op: "play" }));
    expect(session.playing).toBe(false);
    expect(session.playhead).toBe(110);
  });
});
