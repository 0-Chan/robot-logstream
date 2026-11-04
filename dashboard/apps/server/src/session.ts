import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  encodeSeriesBatch,
  type ClientMessage,
  type ServerMessage,
  type SubscribeTopic,
} from "@grandtour/protocol";
import { config } from "./config.ts";
import { indexAtOrBefore, type DataStore, type TopicStore } from "./store.ts";

/** What a session needs from a socket; implemented over Hono's WSContext. */
export interface Sink {
  sendText(msg: string): void;
  sendBinary(data: Uint8Array<ArrayBuffer>): void;
  bufferedAmount(): number;
  isOpen(): boolean;
}

interface FrameSub {
  store: TopicStore;
  lastSent: number; // frame index, -1 = nothing sent in this epoch
  inflight: boolean;
}
interface SeriesSub {
  store: TopicStore;
  maxHz: number;
  sentUpTo: number; // timestamp up to which (inclusive) samples were sent
}

export interface SessionStats {
  framesSent: number;
  framesSkipped: number;
  bytesSent: number;
}

/**
 * One playback clock per connection. Every tick it advances the playhead and pushes:
 *  - series topics: all samples since the last tick, decimated to maxHz (never dropped)
 *  - frame topics: the latest frame at the playhead if it changed (dropped under backpressure)
 */
export class PlaybackSession {
  readonly sessionId = randomUUID();
  playhead: number;
  playing = false;
  speed = 1;
  epoch = 0;
  readonly stats: SessionStats = { framesSent: 0, framesSkipped: 0, bytesSent: 0 };
  private frames = new Map<string, FrameSub>();
  private series = new Map<string, SeriesSub>();
  private lastWall = performance.now();
  private lastClock = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly data: DataStore,
    private readonly sink: Sink,
  ) {
    this.playhead = data.manifest.t0;
  }

  start() {
    this.send({ op: "hello", protocolVersion: PROTOCOL_VERSION, sessionId: this.sessionId, manifest: this.data.manifest });
    this.sendClock();
    this.timer = setInterval(() => this.tick(), config.tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  handle(raw: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send({ op: "error", message: "invalid JSON" });
    }
    switch (msg.op) {
      case "subscribe":
        this.subscribe(msg.topics);
        break;
      case "play":
        // Rewinding at the end is the client's job (it must pick the new epoch), so playing at t1 is a no-op.
        if (msg.speed) this.speed = clampSpeed(msg.speed);
        this.playing = this.playhead < this.data.manifest.t1;
        this.lastWall = performance.now();
        break;
      case "pause":
        this.playing = false;
        break;
      case "speed":
        this.speed = clampSpeed(msg.speed);
        break;
      case "seek":
        // The client owns the epoch; ignore duplicates or reordered seeks that would move it backwards.
        if (!(msg.epoch > this.epoch)) return this.send({ op: "error", message: `stale seek epoch ${msg.epoch} <= ${this.epoch}` });
        this.seek(msg.t, msg.epoch);
        break;
      default:
        return this.send({ op: "error", message: `unknown op ${(msg as { op: string }).op}` });
    }
    this.sendClock();
  }

  private subscribe(topics: SubscribeTopic[]) {
    const nextFrames = new Map<string, FrameSub>();
    const nextSeries = new Map<string, SeriesSub>();
    for (const { name, maxHz } of topics) {
      const store = this.data.byName.get(name);
      if (!store) {
        this.send({ op: "error", message: `unknown topic ${name}` });
        continue;
      }
      if (store.meta.kind === "series") {
        const prev = this.series.get(name);
        const sub = prev ?? { store, maxHz: 0, sentUpTo: this.playhead };
        sub.maxHz = maxHz ?? config.defaultSeriesHz;
        nextSeries.set(name, sub);
        if (!prev) this.backfill(sub);
      } else {
        nextFrames.set(name, this.frames.get(name) ?? { store, lastSent: -1, inflight: false });
      }
    }
    this.frames = nextFrames;
    this.series = nextSeries;
  }

  private seek(t: number, epoch: number) {
    const { t0, t1 } = this.data.manifest;
    this.playhead = Math.min(Math.max(t, t0), t1);
    this.epoch = epoch;
    this.lastWall = performance.now();
    for (const f of this.frames.values()) f.lastSent = -1; // resend at new playhead on next tick
    for (const s of this.series.values()) this.backfill(s);
  }

  private backfill(sub: SeriesSub) {
    sub.sentUpTo = this.playhead - config.backfillSeconds;
    this.flushSeries(sub);
  }

  private flushSeries(sub: SeriesSub) {
    if (this.playhead <= sub.sentUpTo) return;
    const { ts, values } = sub.store.seriesRange(sub.sentUpTo, this.playhead, sub.maxHz);
    sub.sentUpTo = this.playhead;
    if (ts.length === 0) return;
    this.sendBinary(encodeSeriesBatch(sub.store.meta.id, this.epoch, ts, values, sub.store.cols));
  }

  tick() {
    if (!this.sink.isOpen()) return;
    const now = performance.now();
    if (this.playing) {
      this.playhead += ((now - this.lastWall) / 1000) * this.speed;
      if (this.playhead >= this.data.manifest.t1) {
        this.playhead = this.data.manifest.t1;
        this.playing = false;
      }
    }
    this.lastWall = now;

    for (const s of this.series.values()) this.flushSeries(s);
    for (const f of this.frames.values()) this.pushFrame(f);

    if (now - this.lastClock >= config.clockMs) this.sendClock();
  }

  private pushFrame(sub: FrameSub) {
    const i = indexAtOrBefore(sub.store.ts, this.playhead);
    if (i < 0 || i === sub.lastSent || sub.inflight) return;
    if (this.sink.bufferedAmount() > config.maxBufferedBytes) {
      this.stats.framesSkipped++;
      return; // latest-wins: try again next tick with whatever frame is current then
    }
    const epoch = this.epoch;
    sub.inflight = true;
    sub.store
      .readFrame(i)
      .then((payload) => {
        // drop if a seek happened or the topic was unsubscribed while reading
        if (epoch !== this.epoch || this.frames.get(sub.store.meta.name) !== sub) return;
        this.sendBinary(encodeFrame(sub.store.meta.id, epoch, sub.store.ts[i], payload));
        sub.lastSent = i;
        this.stats.framesSent++;
      })
      .catch((err) => this.send({ op: "error", message: `read ${sub.store.meta.name}[${i}]: ${err}` }))
      .finally(() => {
        sub.inflight = false;
      });
  }

  private sendClock() {
    this.lastClock = performance.now();
    this.send({ op: "clock", t: this.playhead, playing: this.playing, speed: this.speed, epoch: this.epoch });
  }

  private send(msg: ServerMessage) {
    if (this.sink.isOpen()) this.sink.sendText(JSON.stringify(msg));
  }

  private sendBinary(data: Uint8Array<ArrayBuffer>) {
    if (!this.sink.isOpen()) return;
    this.stats.bytesSent += data.byteLength;
    this.sink.sendBinary(data);
  }
}

const clampSpeed = (s: number) => Math.min(Math.max(s, 0.1), 8);
