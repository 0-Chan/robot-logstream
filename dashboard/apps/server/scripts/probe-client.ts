// Headless check of the streaming server: subscribe, play, seek, report rates and bandwidth.
//
//   pnpm --filter @grandtour/server probe [-- --url ws://localhost:8787/ws --seconds 6 --speed 1]
//   TOPICS=hesai_points,hdr_front pnpm --filter @grandtour/server probe
//   pnpm --filter @grandtour/server probe -- --seconds 10 --stall 3   # backpressure check

import { parseArgs } from "node:util";
import WebSocket from "ws";
import { MsgType, decodeData, decodePointCloud, type Manifest, type ServerMessage } from "@grandtour/protocol";

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"), // pnpm forwards a literal "--"
  options: {
    url: { type: "string", default: "ws://localhost:8787/ws" },
    seconds: { type: "string", default: "6" },
    speed: { type: "string", default: "1" },
    /** Stop reading the socket for N seconds after the seek, to exercise server backpressure. */
    stall: { type: "string", default: "0" },
  },
});
const DEFAULT_TOPICS = ["hesai_points", "hdr_front", "depth_camera_front_upper", "anymal_state_state_estimator", "stim320_imu"];
const topicNames = process.env.TOPICS ? process.env.TOPICS.split(",") : DEFAULT_TOPICS;
const seconds = Number(args.seconds);

const ws = new WebSocket(args.url!);
ws.binaryType = "arraybuffer";

let manifest: Manifest | null = null;
let epoch = 0;
let stale = 0;
let clockT = 0;
const counts = new Map<number, { msgs: number; samples: number; bytes: number }>();
let seekSentAt = 0;
let seekLatencyMs: number | null = null;
let seekTarget = 0;
let measureFrom = 0;
let lastFrameLag: number | null = null;

const send = (m: object) => ws.send(JSON.stringify(m));

ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    if (msg.op === "hello") {
      manifest = msg.manifest;
      console.log(`hello: ${manifest.sequence}, ${manifest.topics.length} topics`);
      send({ op: "subscribe", topics: topicNames.map((name) => ({ name })) });
      send({ op: "seek", t: manifest.t0 + 60 });
      send({ op: "play", speed: Number(args.speed) });
      setTimeout(runSeekTest, (seconds * 1000) / 2);
      setTimeout(report, seconds * 1000);
    } else if (msg.op === "clock") {
      epoch = msg.epoch;
      clockT = msg.t;
    } else if (msg.op === "error") {
      console.error("server error:", msg.message);
    }
    return;
  }
  const buf = data as ArrayBuffer;
  const m = decodeData(buf);
  if (m.epoch < epoch) {
    stale++;
    return;
  }
  if (seekSentAt && seekLatencyMs === null && m.type === MsgType.Frame && m.epoch > 0 && Math.abs(m.t - seekTarget) < 1) {
    seekLatencyMs = performance.now() - seekSentAt;
  }
  if (m.type === MsgType.Frame) lastFrameLag = clockT - m.t;
  const c = counts.get(m.topicId) ?? { msgs: 0, samples: 0, bytes: 0 };
  c.msgs++;
  c.bytes += buf.byteLength;
  c.samples += m.type === MsgType.SeriesBatch ? m.count : 1;
  if (m.type === MsgType.Frame && manifest?.topics[m.topicId]?.kind === "pointcloud") decodePointCloud(m.payload);
  counts.set(m.topicId, c);
});

const startedAt = performance.now();
function runSeekTest() {
  if (!manifest) return;
  seekTarget = manifest.t0 + 200;
  seekSentAt = performance.now();
  send({ op: "seek", t: seekTarget });
  const stall = Number(args.stall);
  if (stall > 0) {
    const sock = (ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    sock.pause();
    setTimeout(() => sock.resume(), stall * 1000);
  }
  // measure steady-state rates, excluding the post-seek frame snapshot and series backfill
  setTimeout(() => {
    counts.clear();
    measureFrom = performance.now();
  }, 500);
}

function report() {
  if (!manifest) return;
  const window = (performance.now() - measureFrom) / 1000;
  console.log(`\nsteady-state window ${window.toFixed(1)} s (from 0.5 s after seek), speed x${args.speed}, playhead ${(clockT - manifest.t0).toFixed(1)} s`);
  console.log("topic                               msgs/s   samples/s     KB/s");
  let total = 0;
  for (const t of manifest.topics) {
    const c = counts.get(t.id);
    if (!c) continue;
    total += c.bytes;
    console.log(
      `${t.name.padEnd(34)} ${(c.msgs / window).toFixed(1).padStart(7)} ${(c.samples / window).toFixed(1).padStart(11)} ${(c.bytes / 1024 / window).toFixed(0).padStart(8)}`,
    );
  }
  console.log(`total ${(total / 1024 / 1024 / window).toFixed(2)} MB/s, stale dropped ${stale}`);
  console.log(`latest frame lag behind clock: ${lastFrameLag === null ? "n/a" : (lastFrameLag * 1000).toFixed(0) + " ms (media time)"}`);
  console.log(`seek -> first frame at target: ${seekLatencyMs === null ? "n/a" : seekLatencyMs.toFixed(0) + " ms"}`);
  console.log(`elapsed ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);
  ws.close();
}

ws.on("error", (e) => {
  console.error("connection failed:", e.message);
  process.exit(1);
});
