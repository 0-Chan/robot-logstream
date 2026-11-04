// Messages between the main thread and the network worker.
import type { ClientMessage, Manifest } from "@grandtour/protocol";

export type ToWorker =
  /** debugDecodeDelayMs: dev-only artificial decode latency, to test that slow decodes never leak across seeks. */
  | { type: "connect"; url: string; debugDecodeDelayMs?: number }
  /** Seeks must go through the worker, which assigns the epoch (protocol v2). */
  | { type: "seek"; t: number }
  | { type: "send"; msg: Exclude<ClientMessage, { op: "seek" }> };

export type FromWorker =
  | { type: "status"; status: "connecting" | "open" | "closed"; error?: string }
  | { type: "hello"; manifest: Manifest; sessionId: string }
  | { type: "clock"; t: number; playing: boolean; speed: number; epoch: number }
  | { type: "epoch"; epoch: number }
  | {
      type: "pointcloud";
      topicId: number;
      epoch: number;
      t: number;
      n: number;
      /** meters, sensor frame */
      positions: Float32Array;
      /** RGB, 0-255, colored by intensity */
      colors: Uint8Array;
    }
  | { type: "image"; topicId: number; epoch: number; t: number; bitmap: ImageBitmap }
  | { type: "series"; topicId: number; epoch: number; ts: Float64Array; values: Float32Array; cols: number }
  | { type: "stats"; bytesPerSec: number; framesPerSec: number }
  | { type: "error"; message: string };
