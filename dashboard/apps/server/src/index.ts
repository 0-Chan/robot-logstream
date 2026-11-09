import path from "node:path";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { config } from "./config.ts";
import { Notifier, notifyConfigFromEnv } from "./notify.ts";
import { PlaybackSession } from "./session.ts";
import { DataStore } from "./store.ts";
import { GB, TransferMeter, loadTransferState, saveTransferState } from "./transfer.ts";

const data = await DataStore.load(config.preparedDir);
const { manifest } = data;
console.log(
  `loaded ${manifest.sequence}: ${manifest.topics.length} topics, ` +
    `${(manifest.t1 - manifest.t0).toFixed(1)} s from ${config.preparedDir}`,
);

// --- outbound transfer: counted here, alerted through every configured channel, never blocked ---
const meter = new TransferMeter(
  {
    allowanceBytes: config.transferAllowanceGb * GB,
    spikeBytesPerHour: config.spikeGbPerHour * GB,
    overageUsdPerGb: config.overageUsdPerGb,
  },
  config.transferStateFile ? await loadTransferState(config.transferStateFile) : null,
);
const notifier = new Notifier(notifyConfigFromEnv(process.env));
console.log(`transfer alerts: ${notifier.channels().join(", ")}; ${JSON.stringify(meter.usage())}`);
const saveMeter = () =>
  config.transferStateFile
    ? saveTransferState(config.transferStateFile, meter.toJSON()).catch((err) => console.error("transfer state save failed", err))
    : Promise.resolve();
const checkMeter = () => {
  for (const alert of meter.check()) void notifier.send(alert);
  void saveMeter(); // alerts are recorded before they are sent, so a restart does not repeat them
};
checkMeter();
if (config.notifyTest) void notifier.send({ kind: "test", usage: meter.usage() });
setInterval(checkMeter, 60_000).unref();
setInterval(() => void saveMeter(), 10_000).unref();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void saveMeter().finally(() => process.exit(0)));
}
let sessions = 0;

const app = new Hono();
app.use("*", cors());
app.use("*", async (c, next) => {
  await next();
  meter.add(Number(c.res.headers.get("content-length") ?? 0));
});

app.get("/health", (c) => c.json({ ok: true, sequence: manifest.sequence, sessions, transfer: meter.usage() }));

// Static, non-streaming assets (manifest, tf tree, map) over plain HTTP.
const staticRoot = path.relative(process.cwd(), config.preparedDir) || ".";
app.get("/manifest.json", serveStatic({ root: staticRoot }));
app.use("/static/*", serveStatic({ root: staticRoot }));

app.get(
  "/ws",
  upgradeWebSocket(() => {
    let session: PlaybackSession | null = null;
    return {
      onOpen(_evt, ws) {
        const raw = ws.raw as WebSocket; // underlying `ws` socket: needed for bufferedAmount
        sessions++;
        session = new PlaybackSession(data, {
          sendText: (s) => {
            ws.send(s);
            meter.add(Buffer.byteLength(s));
          },
          sendBinary: (b) => {
            ws.send(b);
            meter.add(b.byteLength);
          },
          bufferedAmount: () => raw.bufferedAmount,
          isOpen: () => raw.readyState === raw.OPEN,
        });
        session.start();
      },
      onMessage(evt) {
        if (typeof evt.data === "string") session?.handle(evt.data);
      },
      onClose() {
        if (session) {
          sessions--;
          const s = session.stats;
          console.log(
            `session closed: ${s.framesSent} frames sent, ${s.framesSkipped} skipped (backpressure), ` +
              `${(s.bytesSent / 1024 / 1024).toFixed(1)} MB`,
          );
        }
        session?.stop();
        session = null;
      },
      onError(err) {
        console.error("ws error", err);
      },
    };
  }),
);

const wss = new WebSocketServer({ noServer: true });
serve({ fetch: app.fetch, port: config.port, websocket: { server: wss } }, (info) => {
  console.log(`listening on http://localhost:${info.port}  (ws://localhost:${info.port}/ws)`);
});
