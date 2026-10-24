import { describe, expect, it } from "vitest";
import {
  HEADER_BYTES,
  MsgType,
  decodeData,
  decodePointCloud,
  encodeFrame,
  encodeSeriesBatch,
} from "./messages.ts";

const copyBuffer = (u: Uint8Array) => u.slice().buffer; // what a WebSocket delivers

describe("FRAME", () => {
  it("round-trips header and payload", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const msg = decodeData(copyBuffer(encodeFrame(513, 7, 1730563883.0039854, payload)));
    expect(msg.type).toBe(MsgType.Frame);
    expect(msg.topicId).toBe(513);
    expect(msg.epoch).toBe(7);
    expect(msg.t).toBe(1730563883.0039854);
    if (msg.type !== MsgType.Frame) throw new Error();
    expect([...msg.payload]).toEqual([1, 2, 3, 4, 5]);
  });

  it("decodes a pointcloud payload", () => {
    const n = 3;
    const body = new Uint8Array(4 + n * 7);
    const v = new DataView(body.buffer);
    v.setUint32(0, n, true);
    const xyz = [100, -200, 300, 32767, -32767, 0, 1, 2, 3];
    xyz.forEach((q, i) => v.setInt16(4 + i * 2, q, true));
    body.set([10, 20, 255], 4 + n * 6);
    const msg = decodeData(copyBuffer(encodeFrame(0, 0, 0, body)));
    if (msg.type !== MsgType.Frame) throw new Error();
    const pc = decodePointCloud(msg.payload);
    expect(pc.n).toBe(3);
    expect([...pc.xyz]).toEqual(xyz);
    expect([...pc.intensity]).toEqual([10, 20, 255]);
  });
});

describe("SERIES_BATCH", () => {
  it("round-trips timestamps and row-major values", () => {
    const ts = new Float64Array([1.5, 2.5, 3.5]);
    const values = new Float32Array([1, 2, 3, 4, 5, 6]);
    const enc = encodeSeriesBatch(42, 3, ts, values, 2);
    expect(enc.byteLength).toBe(HEADER_BYTES + 8 + 3 * 8 + 6 * 4);
    const msg = decodeData(copyBuffer(enc));
    if (msg.type !== MsgType.SeriesBatch) throw new Error();
    expect(msg.topicId).toBe(42);
    expect(msg.t).toBe(3.5);
    expect(msg.count).toBe(3);
    expect(msg.cols).toBe(2);
    expect([...msg.ts]).toEqual([1.5, 2.5, 3.5]);
    expect([...msg.values]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("handles an empty batch", () => {
    const msg = decodeData(copyBuffer(encodeSeriesBatch(1, 0, new Float64Array(0), new Float32Array(0), 4)));
    if (msg.type !== MsgType.SeriesBatch) throw new Error();
    expect(msg.count).toBe(0);
  });

  it("rejects mismatched value length", () => {
    expect(() => encodeSeriesBatch(1, 0, new Float64Array(2), new Float32Array(3), 2)).toThrow();
  });
});
