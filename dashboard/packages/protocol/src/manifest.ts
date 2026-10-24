// Shape of prepared/<sequence>/manifest.json, written by dashboard/preprocess (cli.py).

export type TopicKind = "pointcloud" | "image" | "depth" | "series";

export interface Transform {
  parent: string;
  child?: string;
  translation: [number, number, number];
  /** Quaternion in x, y, z, w order (same as three.js). */
  rotationXyzw: [number, number, number, number];
}

export interface CameraInfo {
  K: number[];
  D: number[];
  P: number[];
  R: number[];
  width: number;
  height: number;
  distortion_model: string;
  frame_id: string;
}

interface TopicBase {
  id: number;
  name: string;
  kind: TopicKind;
  dir: string;
  count: number;
  t0: number;
  t1: number;
  hz: number | null;
  frameId: string;
  description: string;
  transform: Transform | null;
  files: Record<string, string>;
}

export interface PointCloudTopic extends TopicBase {
  kind: "pointcloud";
  /** Meters per int16 step. */
  positionScale: number;
  /** u8 intensity = raw intensity * intensityScale. */
  intensityScale: number;
  meanPoints: number;
  bytes: number;
}

export interface ImageTopic extends TopicBase {
  kind: "image" | "depth";
  encoding: "jpeg" | "png16";
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  /** Multiply fx, fy, cx, cy of cameraInfo.K by this for the stored resolution. */
  scale: number;
  cameraInfo: CameraInfo | null;
  depthUnit?: string;
  bytes: number;
}

export interface SeriesColumn {
  name: string;
  /** Real value = stored float32 + offset (float64). */
  offset: number;
}

export interface SeriesTopic extends TopicBase {
  kind: "series";
  columns: SeriesColumn[];
  droppedFields: string[];
}

export type TopicMeta = PointCloudTopic | ImageTopic | SeriesTopic;

export interface MapInfo {
  file: string;
  points: number;
  voxel: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  sameFrameAs: string;
}

export interface Manifest {
  layoutVersion: number;
  sequence: string;
  t0: number;
  t1: number;
  quaternionOrder: "xyzw";
  static: { tf: string; map?: MapInfo };
  topics: TopicMeta[];
}

export interface TfFile {
  frames: Record<string, Transform>;
}

export const isFrameTopic = (t: TopicMeta): t is PointCloudTopic | ImageTopic => t.kind !== "series";
