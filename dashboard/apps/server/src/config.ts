import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

export const config = {
  /** prepared/<sequence> directory produced by `uv run prep`. */
  preparedDir: path.resolve(process.env.PREPARED_DIR ?? path.join(repoRoot, "data/prepared/2024-11-02-17-10-25")),
  port: Number(process.env.PORT ?? 8787),
  /** Commit of the running image (set at build time), reported by /health. */
  version: process.env.APP_VERSION || "dev",
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
  /** Outbound transfer included in the hosting plan (Lightsail small_3_0: 3 TB). Alerts only, never blocks. */
  transferAllowanceGb: Number(process.env.TRANSFER_ALLOWANCE_GB ?? 3000),
  /** Alert when the last hour alone sent more than this (~3 viewers watching for a full hour). */
  spikeGbPerHour: Number(process.env.SPIKE_GB_PER_HOUR ?? 50),
  /** Price per GB above the allowance (Lightsail Seoul), for the projected-cost line in alerts. */
  overageUsdPerGb: Number(process.env.OVERAGE_USD_PER_GB ?? 0.13),
  /** Where the month's count is kept across restarts; unset = memory only (local dev). */
  transferStateFile: process.env.TRANSFER_STATE_FILE || null,
  /** Send one test alert at startup to check the channel settings. */
  notifyTest: process.env.NOTIFY_TEST === "1",
};
