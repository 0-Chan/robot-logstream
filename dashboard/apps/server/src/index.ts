import path from "node:path";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { config } from "./config.ts";
import { PlaybackSession } from "./session.ts";
import { DataStore } from "./store.ts";

const data = await DataStore.load(config.preparedDir);
const { manifest } = data;
console.log(
  `loaded ${manifest.sequence}: ${manifest.topics.length} topics, ` +
    `${(manifest.t1 - manifest.t0).toFixed(1)} s from ${config.preparedDir}`,
);

const app = new Hono();
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, sequence: manifest.sequence }));

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
        session = new PlaybackSession(data, {
          sendText: (s) => ws.send(s),
          sendBinary: (b) => ws.send(b),
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
