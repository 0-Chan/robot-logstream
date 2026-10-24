// Messages between the main thread and the network worker.
import type { ClientMessage, Manifest } from "@grandtour/protocol";

export type ToWorker = { type: "connect"; url: string } | { type: "send"; msg: ClientMessage };

export type FromWorker =
  | { type: "status"; status: "connecting" | "open" | "closed"; error?: string }
  | { type: "hello"; manifest: Manifest }
  | { type: "clock"; t: number; playing: boolean; speed: number; epoch: number }
  | { type: "epoch"; epoch: number }
  | {
      type: "pointcloud";
      topicId: number;
      t: number;
      n: number;
      /** meters, sensor frame */
      positions: Float32Array;
      /** RGB, 0-255, colored by intensity */
      colors: Uint8Array;
    }
  | { type: "image"; topicId: number; t: number; bitmap: ImageBitmap }
  | { type: "series"; topicId: number; ts: Float64Array; values: Float32Array; cols: number }
  | { type: "stats"; bytesPerSec: number; framesPerSec: number }
  | { type: "error"; message: string };
