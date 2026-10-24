// Main-thread side of the network worker: routes decoded data into `live`, control into zustand.
import { toast } from "sonner";
import type { ClientMessage, TfFile } from "@grandtour/protocol";
import { live } from "../data/live.ts";
import { useApp } from "../state.ts";
import type { FromWorker, ToWorker } from "./messages.ts";

export const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "http://localhost:8787";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const toWorker = (m: ToWorker) => worker.postMessage(m);

let disconnected = false;

export const send = (msg: ClientMessage) => toWorker({ type: "send", msg });

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "status":
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
      useApp.setState({ manifest: m.manifest });
      loadTf();
      break;
    case "clock":
      useApp.setState({ clock: { t: m.t, playing: m.playing, speed: m.speed, epoch: m.epoch, receivedAt: performance.now() } });
      break;
    case "epoch":
      live.epoch = m.epoch;
      for (const b of live.series.values()) b.clear();
      break;
    case "pointcloud": {
      const prev = live.pointclouds.get(m.topicId);
      live.pointclouds.set(m.topicId, { t: m.t, n: m.n, positions: m.positions, colors: m.colors, version: (prev?.version ?? 0) + 1 });
      break;
    }
    case "image": {
      const prev = live.images.get(m.topicId);
      prev?.bitmap.close();
      live.images.set(m.topicId, { t: m.t, bitmap: m.bitmap, version: (prev?.version ?? 0) + 1 });
      break;
    }
    case "series":
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
  toWorker({ type: "connect", url: ws });
}
