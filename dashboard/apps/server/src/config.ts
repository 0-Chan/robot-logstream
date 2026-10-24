import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

export const config = {
  /** prepared/<sequence> directory produced by `uv run prep`. */
  preparedDir: path.resolve(process.env.PREPARED_DIR ?? path.join(repoRoot, "data/prepared/2024-11-02-17-10-25")),
  port: Number(process.env.PORT ?? 8787),
  /** Playback loop period. */
  tickMs: 20,
  /** Clock broadcast period. */
  clockMs: 100,
  /** Skip frame topics for a tick while the socket has more than this queued (latest-wins). */
  maxBufferedBytes: 2 * 1024 * 1024,
  /** Default series rate when the client does not ask for one. */
  defaultSeriesHz: 100,
  /** Series history sent after seek / new subscription. */
  backfillSeconds: 5,
};
