/// <reference lib="webworker" />
// Owns the WebSocket: decodes binary messages off the main thread and posts ready-to-render data
// (Float32 positions, ImageBitmaps, series arrays) back with transferable buffers.

import { decode as decodePng } from "fast-png";
import {
  MsgType,
  decodeData,
  decodePointCloud,
  type Manifest,
  type PointCloudTopic,
  type ServerMessage,
} from "@grandtour/protocol";
import { TURBO_LUT } from "./colormap.ts";
import { Gate } from "./gate.ts";
import type { FromWorker, ToWorker } from "./messages.ts";

declare const self: DedicatedWorkerGlobalScope;

let ws: WebSocket | null = null;
let manifest: Manifest | null = null;
const gate = new Gate();
let debugDecodeDelayMs = 0;
let bytes = 0;
let frames = 0;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

// depth (mm, estimated) -> turbo, fixed range so colors are comparable across frames
const DEPTH_MIN = 300;
const DEPTH_MAX = 8000;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === "connect") {
    debugDecodeDelayMs = m.debugDecodeDelayMs ?? 0;
    connect(m.url);
  }
  else if (m.type === "seek") seek(m.t);
  else if (m.type === "send" && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m.msg));
};

/**
 * Seeks go through the worker because it owns the epoch: bump it, tell the main thread (which drops
 * everything older right away), then ask the server. Data for the old position is rejected from this
 * moment on, even if it is already in flight.
 */
function seek(t: number) {
  const epoch = gate.nextEpoch();
  post({ type: "epoch", epoch });
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "seek", t, epoch }));
}

function connect(url: string) {
  if (ws) {
    // detach first: a late onclose from the old socket must not report "closed" for the new one
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    ws.close();
  }
  const socketId = gate.newSocket();
  post({ type: "status", status: "connecting" });
  const sock = new WebSocket(url);
  ws = sock;
  sock.binaryType = "arraybuffer";
  let error: string | undefined;
  sock.onopen = () => post({ type: "status", status: "open" });
  // onerror is always followed by onclose: report once, from onclose
  sock.onerror = () => {
    error = `cannot connect to ${url}`;
  };
  sock.onclose = () => post({ type: "status", status: "closed", error });
  sock.onmessage = (ev) => {
    if (typeof ev.data === "string") onControl(JSON.parse(ev.data) as ServerMessage);
    else onData(socketId, ev.data as ArrayBuffer).catch((err) => post({ type: "error", message: String(err) }));
  };
}

function onControl(msg: ServerMessage) {
  if (msg.op === "hello") {
    manifest = msg.manifest;
    post({ type: "hello", manifest: msg.manifest, sessionId: msg.sessionId });
  } else if (msg.op === "clock") {
    // A clock from before our latest seek would jump the playhead back to the old position.
    if (msg.epoch !== gate.epoch) return;
    post({ type: "clock", t: msg.t, playing: msg.playing, speed: msg.speed, epoch: msg.epoch });
  } else if (msg.op === "error") {
    post({ type: "error", message: msg.message });
  }
}

async function onData(socketId: number, buf: ArrayBuffer) {
  bytes += buf.byteLength;
  const m = decodeData(buf);
  const topic = manifest?.topics[m.topicId];
  if (!topic || !gate.admits(socketId, m.epoch, m.topicId, m.t)) return;
  // Re-checked with commit() right before posting: the work below (esp. async decodes) can be
  // overtaken by a seek, a reconnect, or a newer frame of the same topic.
  const deliver = () => gate.commit(socketId, m.epoch, m.topicId, m.t);

  if (m.type === MsgType.SeriesBatch) {
    if (!deliver()) return;
    // copy out of the socket buffer so the arrays can be transferred independently
    const ts = m.ts.slice();
    const values = m.values.slice();
    post({ type: "series", topicId: m.topicId, epoch: m.epoch, ts, values, cols: m.cols }, [ts.buffer, values.buffer]);
    return;
  }
  frames++;
  if (topic.kind === "pointcloud") {
    const { positions, colors, n } = pointCloud(topic, m.payload);
    if (!deliver()) return;
    post({ type: "pointcloud", topicId: m.topicId, epoch: m.epoch, t: m.t, n, positions, colors }, [positions.buffer, colors.buffer]);
  } else {
    const bitmap =
      topic.kind === "image" ? await createImageBitmap(new Blob([m.payload], { type: "image/jpeg" })) : await depthBitmap(m.payload);
    if (debugDecodeDelayMs) await new Promise((r) => setTimeout(r, debugDecodeDelayMs * (0.5 + Math.random())));
    if (!deliver()) {
      bitmap.close();
      return;
    }
    post({ type: "image", topicId: m.topicId, epoch: m.epoch, t: m.t, bitmap }, [bitmap]);
  }
}

function pointCloud(topic: PointCloudTopic, payload: Uint8Array) {
  const pc = decodePointCloud(payload);
  const positions = new Float32Array(pc.n * 3);
  const s = topic.positionScale;
  for (let i = 0; i < pc.n * 3; i++) positions[i] = pc.xyz[i] * s;
  const colors = new Uint8Array(pc.n * 3);
  for (let i = 0; i < pc.n; i++) {
    const k = pc.intensity[i] * 3;
    colors[i * 3] = TURBO_LUT[k];
    colors[i * 3 + 1] = TURBO_LUT[k + 1];
    colors[i * 3 + 2] = TURBO_LUT[k + 2];
  }
  return { positions, colors, n: pc.n };
}

async function depthBitmap(payload: Uint8Array) {
  const png = decodePng(payload);
  const src = png.data as Uint16Array;
  const { width, height } = png;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const span = DEPTH_MAX - DEPTH_MIN;
  for (let i = 0; i < width * height; i++) {
    const d = src[i];
    if (d === 0) continue; // no measurement -> transparent
    const k = Math.round(Math.min(1, Math.max(0, (d - DEPTH_MIN) / span)) * 255) * 3;
    rgba[i * 4] = TURBO_LUT[k];
    rgba[i * 4 + 1] = TURBO_LUT[k + 1];
    rgba[i * 4 + 2] = TURBO_LUT[k + 2];
    rgba[i * 4 + 3] = 255;
  }
  return createImageBitmap(new ImageData(rgba, width, height));
}

setInterval(() => {
  post({ type: "stats", bytesPerSec: bytes, framesPerSec: frames });
  bytes = 0;
  frames = 0;
}, 1000);
