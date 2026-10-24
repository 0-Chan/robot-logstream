import { open, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Manifest, TopicMeta } from "@grandtour/protocol";

/** Last index i with ts[i] <= t, or -1. */
export function indexAtOrBefore(ts: Float64Array, t: number): number {
  let lo = 0;
  let hi = ts.length; // first index with ts > t
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ts[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Indices of samples in [from, to) to send so the rate stays <= maxHz: keeps the first sample of
 * every 1/maxHz bucket. Buckets are aligned to absolute time and the decision only looks at the
 * previous sample, so splitting a range into consecutive windows gives the same result.
 */
export function decimate(ts: Float64Array, from: number, to: number, maxHz: number): number[] {
  const out: number[] = [];
  if (to <= from) return out;
  if (!(maxHz > 0)) {
    for (let i = from; i < to; i++) out.push(i);
    return out;
  }
  const bucket = (i: number) => Math.floor(ts[i] * maxHz);
  for (let i = from; i < to; i++) {
    if (i === 0 || bucket(i) !== bucket(i - 1)) out.push(i);
  }
  return out;
}

async function readTyped<T>(file: string, ctor: new (b: ArrayBuffer) => T): Promise<T> {
  const buf = await readFile(file);
  // copy into a fresh, aligned ArrayBuffer
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new ctor(ab);
}

export class TopicStore {
  readonly ts: Float64Array;
  private constructor(
    readonly meta: TopicMeta,
    ts: Float64Array,
    readonly offsets: BigUint64Array | null,
    readonly values: Float32Array | null,
    private readonly frames: FileHandle | null,
  ) {
    this.ts = ts;
  }

  static async load(root: string, meta: TopicMeta): Promise<TopicStore> {
    const dir = path.join(root, meta.dir);
    const ts = await readTyped(path.join(dir, meta.files.timestamps), Float64Array);
    if (meta.kind === "series") {
      const values = await readTyped(path.join(dir, meta.files.values), Float32Array);
      if (values.length !== ts.length * meta.columns.length) throw new Error(`${meta.name}: values size mismatch`);
      return new TopicStore(meta, ts, null, values, null);
    }
    const offsets = await readTyped(path.join(dir, meta.files.offsets), BigUint64Array);
    if (offsets.length !== ts.length + 1) throw new Error(`${meta.name}: offsets size mismatch`);
    const fh = await open(path.join(dir, meta.files.frames), "r");
    return new TopicStore(meta, ts, offsets, null, fh);
  }

  get cols(): number {
    return this.meta.kind === "series" ? this.meta.columns.length : 0;
  }

  async readFrame(i: number): Promise<Uint8Array> {
    if (!this.frames || !this.offsets) throw new Error(`${this.meta.name} is not a frame topic`);
    const start = Number(this.offsets[i]);
    const len = Number(this.offsets[i + 1]) - start;
    const buf = Buffer.allocUnsafe(len);
    await this.frames.read(buf, 0, len, start);
    return buf;
  }

  /** Series rows (from, to] in time, decimated to maxHz. */
  seriesRange(tFrom: number, tTo: number, maxHz: number): { ts: Float64Array; values: Float32Array } {
    const a = indexAtOrBefore(this.ts, tFrom) + 1;
    const b = indexAtOrBefore(this.ts, tTo) + 1;
    const idx = decimate(this.ts, a, b, maxHz);
    const cols = this.cols;
    const ts = new Float64Array(idx.length);
    const values = new Float32Array(idx.length * cols);
    idx.forEach((i, k) => {
      ts[k] = this.ts[i];
      values.set(this.values!.subarray(i * cols, (i + 1) * cols), k * cols);
    });
    return { ts, values };
  }

  async close() {
    await this.frames?.close();
  }
}

export class DataStore {
  private constructor(
    readonly manifest: Manifest,
    readonly byName: Map<string, TopicStore>,
  ) {}

  static async load(root: string): Promise<DataStore> {
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as Manifest;
    const stores = await Promise.all(manifest.topics.map((m) => TopicStore.load(root, m)));
    return new DataStore(manifest, new Map(stores.map((s) => [s.meta.name, s])));
  }
}
