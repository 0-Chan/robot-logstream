// React-facing state: connection, playback clock, and what the user chose to look at.
// Streamed data itself lives in data/live.ts.
import { create } from "zustand";
import type { Manifest, TfFile } from "@grandtour/protocol";

export interface ChartConfig {
  topic: string;
  columns: string[];
}

export interface UiState {
  lidar: string | null;
  worldView: boolean;
  showMap: boolean;
  cameras: [string | null, string | null];
  charts: [ChartConfig | null, ChartConfig | null];
  chartWindowSec: number;
}

interface AppState {
  status: "connecting" | "open" | "closed";
  error: string | null;
  manifest: Manifest | null;
  tf: TfFile | null;
  clock: { t: number; playing: boolean; speed: number; epoch: number; receivedAt: number };
  stats: { mbPerSec: number; framesPerSec: number };
  ui: UiState;
  setUi: (patch: Partial<UiState>) => void;
}

export const useApp = create<AppState>()((set) => ({
  status: "connecting",
  error: null,
  manifest: null,
  tf: null,
  clock: { t: 0, playing: false, speed: 1, epoch: 0, receivedAt: 0 },
  stats: { mbPerSec: 0, framesPerSec: 0 },
  ui: {
    lidar: "hesai_points",
    worldView: true,
    showMap: true,
    cameras: ["hdr_front", "depth_camera_front_upper"],
    charts: [
      { topic: "anymal_state_state_estimator", columns: ["joint_positions.LF_HAA", "joint_positions.LF_HFE", "joint_positions.LF_KFE"] },
      { topic: "stim320_imu", columns: ["ang_vel.x", "ang_vel.y", "ang_vel.z"] },
    ],
    chartWindowSec: 10,
  },
  setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
}));

/** Playhead estimated between 10 Hz server clock messages. */
export function estimatePlayhead(): number {
  const { clock, manifest } = useApp.getState();
  if (!clock.playing) return clock.t;
  const t = clock.t + ((performance.now() - clock.receivedAt) / 1000) * clock.speed;
  return manifest ? Math.min(t, manifest.t1) : t;
}

/** Pose topic used to place everything in the DLIO map frame (verified: pose of hesai_lidar). */
export const WORLD_POSE_TOPIC = "dlio_map_odometry";
export const WORLD_POSE_FRAME = "hesai_lidar";
