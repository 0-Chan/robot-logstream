// WebSocket protocol shared by server and web client.
//
// Control messages are JSON text frames. Data messages are binary frames with a 16-byte header,
// so typed-array views into the payload are always aligned:
//
//   [u8 version][u8 msgType][u16 topicId][u32 epoch][f64 timestamp] | payload
//
//   FRAME        payload = the topic's frame bytes as stored in frames.bin
//                 pointcloud: [u32 n][i16 xyz * n][u8 intensity * n]
//                 image/depth: a JPEG / 16-bit PNG file
//   SERIES_BATCH payload = [u32 count][u32 cols][f64 ts * count][f32 values * count * cols]
//
// Epochs (v2): the CLIENT owns the epoch. Every seek carries a new, strictly larger epoch and the
// server stamps all data produced after it with that value. The client bumps its epoch the moment it
// sends the seek, so data for the old position can never be mistaken for the new one. Each connection
// is a new session (sessionId in hello); the client also discards anything from older sockets.

import type { Manifest } from "./manifest.ts";

export const PROTOCOL_VERSION = 2;
export const HEADER_BYTES = 16;

export const MsgType = { Frame: 1, SeriesBatch: 2 } as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];

// ---- control: client -> server ----
export interface SubscribeTopic {
  name: string;
  /** Series only: max samples per second to stream (default chosen by server). */
  maxHz?: number;
}
export type ClientMessage =
  | { op: "subscribe"; topics: SubscribeTopic[] }
  | { op: "play"; speed?: number }
  | { op: "pause" }
  /** epoch must be greater than any epoch sent before on this connection. */
  | { op: "seek"; t: number; epoch: number }
  | { op: "speed"; speed: number };

// ---- control: server -> client ----
export type ServerMessage =
  | { op: "hello"; protocolVersion: number; sessionId: string; manifest: Manifest }
  | { op: "clock"; t: number; playing: boolean; speed: number; epoch: number }
  | { op: "error"; message: string };

// ---- binary encode ----
function header(buf: ArrayBuffer, type: MsgType, topicId: number, epoch: number, t: number) {
  const v = new DataView(buf);
  v.setUint8(0, PROTOCOL_VERSION);
  v.setUint8(1, type);
  v.setUint16(2, topicId, true);
  v.setUint32(4, epoch >>> 0, true);
  v.setFloat64(8, t, true);
}

export function encodeFrame(topicId: number, epoch: number, t: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  header(out.buffer, MsgType.Frame, topicId, epoch, t);
  out.set(payload, HEADER_BYTES);
  return out;
}

export function encodeSeriesBatch(
  topicId: number,
  epoch: number,
  ts: Float64Array,
  values: Float32Array,
  cols: number,
): Uint8Array<ArrayBuffer> {
  const count = ts.length;
  if (values.length !== count * cols) throw new Error("values length must be count * cols");
  const out = new Uint8Array(HEADER_BYTES + 8 + count * 8 + count * cols * 4);
  header(out.buffer, MsgType.SeriesBatch, topicId, epoch, count ? ts[count - 1] : 0);
  const v = new DataView(out.buffer);
  v.setUint32(HEADER_BYTES, count, true);
  v.setUint32(HEADER_BYTES + 4, cols, true);
  new Float64Array(out.buffer, HEADER_BYTES + 8, count).set(ts);
  new Float32Array(out.buffer, HEADER_BYTES + 8 + count * 8, count * cols).set(values);
  return out;
}

// ---- binary decode ----
export interface FrameMessage {
  type: typeof MsgType.Frame;
  topicId: number;
  epoch: number;
  t: number;
  payload: Uint8Array<ArrayBuffer>;
}
export interface SeriesBatchMessage {
  type: typeof MsgType.SeriesBatch;
  topicId: number;
  epoch: number;
  t: number;
  count: number;
  cols: number;
  ts: Float64Array;
  /** Row-major count x cols. Add each column's manifest offset for real values. */
  values: Float32Array;
}
export type DataMessage = FrameMessage | SeriesBatchMessage;

/** `buf` must start at the message start (as WebSocket ArrayBuffers do) to keep views aligned. */
export function decodeData(buf: ArrayBuffer): DataMessage {
  const v = new DataView(buf);
  const version = v.getUint8(0);
  if (version !== PROTOCOL_VERSION) throw new Error(`protocol version ${version} != ${PROTOCOL_VERSION}`);
  const type = v.getUint8(1);
  const topicId = v.getUint16(2, true);
  const epoch = v.getUint32(4, true);
  const t = v.getFloat64(8, true);
  if (type === MsgType.Frame) {
    return { type, topicId, epoch, t, payload: new Uint8Array(buf, HEADER_BYTES) };
  }
  if (type === MsgType.SeriesBatch) {
    const count = v.getUint32(HEADER_BYTES, true);
    const cols = v.getUint32(HEADER_BYTES + 4, true);
    const ts = new Float64Array(buf, HEADER_BYTES + 8, count);
    const values = new Float32Array(buf, HEADER_BYTES + 8 + count * 8, count * cols);
    return { type, topicId, epoch, t, count, cols, ts, values };
  }
  throw new Error(`unknown message type ${type}`);
}

export interface PointCloudFrame {
  n: number;
  /** Quantized positions; multiply by the topic's positionScale for meters. */
  xyz: Int16Array;
  intensity: Uint8Array;
}

/** Decode a pointcloud FRAME payload. Copies if the payload is not 2-byte aligned. */
export function decodePointCloud(payload: Uint8Array): PointCloudFrame {
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const n = v.getUint32(0, true);
  const start = payload.byteOffset + 4;
  const xyz =
    start % 2 === 0
      ? new Int16Array(payload.buffer, start, n * 3)
      : new Int16Array(payload.slice(4, 4 + n * 6).buffer);
  const intensity = new Uint8Array(payload.buffer, start + n * 6, n);
  return { n, xyz, intensity };
}
