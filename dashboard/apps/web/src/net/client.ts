// Main-thread side of the network worker: routes decoded data into `live` (data plane) and
// control state into zustand (React). Also owns playback commands, so seeks always get an epoch
// and a reconnect resumes where the user was.
import { toast } from "sonner";
import type { TfFile } from "@grandtour/protocol";
import { freeze, seekTo } from "../data/clock.ts";
import { live } from "../data/live.ts";
import { estimatePlayhead, useApp } from "../state.ts";
import type { FromWorker, ToWorker } from "./messages.ts";

export const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "http://localhost:8787";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const toWorker = (m: ToWorker) => worker.postMessage(m);

let disconnected = false;
/** Where to continue after a reconnect (a new server session starts at t0, paused). */
let resume: { t: number; playing: boolean; speed: number } | null = null;

export const send = (msg: Extract<ToWorker, { type: "send" }>["msg"]) => toWorker({ type: "send", msg });

const isOpen = () => useApp.getState().status === "open";

/** Seek the whole screen. The playhead moves immediately; samples of the old position are dropped. */
export function seek(t: number) {
  const { manifest, clock } = useApp.getState();
  if (!manifest || !isOpen()) return;
  const target = Math.min(Math.max(t, manifest.t0), manifest.t1);
  useApp.setState({ clock: seekTo(clock, target, performance.now()) });
  toWorker({ type: "seek", t: target });
}

export function play() {
  const { manifest } = useApp.getState();
  if (!manifest || !isOpen()) return;
  if (estimatePlayhead() >= manifest.t1 - 0.05) seek(manifest.t0); // rewind is the client's job (needs an epoch)
  send({ op: "play" });
}

export const pause = () => isOpen() && send({ op: "pause" });
export const setSpeed = (speed: number) => isOpen() && send({ op: "speed", speed });

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "status":
      if (m.status === "closed" && useApp.getState().status === "open") {
        // Freeze the playhead where it is and remember it, before marking the connection closed.
        const { clock, manifest } = useApp.getState();
        const frozen = freeze(clock, performance.now(), manifest?.t1 ?? Infinity);
        resume = { t: frozen.t, playing: clock.playing, speed: clock.speed };
        useApp.setState({ clock: { ...frozen, playing: false } });
      }
      useApp.setState({ status: m.status, error: m.error ?? (m.status === "open" ? null : useApp.getState().error) });
      if (m.status === "closed") {
        // one toast (fixed id) that stays while reconnecting, instead of one per retry
        toast.error("서버 연결이 끊겼습니다", { id: "connection", description: "2초마다 다시 연결합니다.", duration: Infinity });
        disconnected = true;
        setTimeout(connect, 2000); // simple reconnect
      } else if (m.status === "open" && disconnected) {
        toast.success("서버에 다시 연결했습니다", { id: "connection", duration: 3000 });
        disconnected = false;
      }
      break;
    case "hello":
      live.reset();
      // New manifest object -> App's subscription effect re-subscribes on this session.
      useApp.setState({ manifest: m.manifest });
      loadTf();
      if (resume) {
        const r = resume;
        resume = null;
        seek(r.t);
        send({ op: "speed", speed: r.speed });
        if (r.playing) send({ op: "play" });
      }
      break;
    case "clock":
      // The worker already dropped clocks from before our latest seek.
      useApp.setState({ clock: { t: m.t, playing: m.playing, speed: m.speed, epoch: m.epoch, receivedAt: performance.now() } });
      break;
    case "epoch":
      live.setEpoch(m.epoch);
      break;
    case "pointcloud": {
      if (m.epoch !== live.epoch) break; // defensive: the worker gate should already guarantee this
      const prev = live.pointclouds.get(m.topicId);
      live.pointclouds.set(m.topicId, { epoch: m.epoch, t: m.t, n: m.n, positions: m.positions, colors: m.colors, version: (prev?.version ?? 0) + 1 });
      break;
    }
    case "image": {
      if (m.epoch !== live.epoch) {
        m.bitmap.close();
        break;
      }
      const prev = live.images.get(m.topicId);
      prev?.bitmap.close();
      live.images.set(m.topicId, { epoch: m.epoch, t: m.t, bitmap: m.bitmap, version: (prev?.version ?? 0) + 1 });
      break;
    }
    case "series":
      if (m.epoch !== live.epoch) break;
      live.seriesFor(m.topicId, m.cols).push(m.ts, m.values);
      break;
    case "stats":
      useApp.setState({ stats: { mbPerSec: m.bytesPerSec / 1024 / 1024, framesPerSec: m.framesPerSec } });
      break;
    case "error":
      console.warn("[server]", m.message);
      useApp.setState({ error: m.message });
      toast.error("서버 오류", { description: m.message });
      break;
  }
};

async function loadTf() {
  const res = await fetch(`${SERVER_URL}/static/tf.json`);
  useApp.setState({ tf: (await res.json()) as TfFile });
}

export function connect() {
  const ws = SERVER_URL.replace(/^http/, "ws") + "/ws";
  // ?decodeDelay=300 (dev only): slow down image decodes to exercise the post-decode epoch check
  const delay = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get("decodeDelay") ?? 0) : 0;
  toWorker({ type: "connect", url: ws, debugDecodeDelayMs: delay || undefined });
}
