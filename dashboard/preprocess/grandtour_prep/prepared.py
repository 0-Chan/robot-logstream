"""Readers for the prepared/ layout and small rigid-transform helpers (quaternions are xyzw)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation, Slerp


def read_map(prepared: Path) -> np.ndarray:
    """static/map.bin -> (N, 3) float32 points in the dlio_map frame."""
    buf = (prepared / "static" / "map.bin").read_bytes()
    n = int(np.frombuffer(buf, "<u4", 1)[0])
    return np.frombuffer(buf, "<f4", n * 3, 4).reshape(n, 3)


def topic_meta(prepared: Path, topic: str) -> dict:
    return json.loads((prepared / "topics" / topic / "meta.json").read_text())


def read_series(prepared: Path, topic: str) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Timestamps and columns (offsets added back, float64)."""
    tdir = prepared / "topics" / topic
    meta = topic_meta(prepared, topic)
    ts = np.fromfile(tdir / "timestamps.f64", "<f8")
    vals = np.fromfile(tdir / "values.f32", "<f4").reshape(len(ts), len(meta["columns"]))
    return ts, {c["name"]: vals[:, i].astype(np.float64) + c["offset"] for i, c in enumerate(meta["columns"])}


class PointCloudTopic:
    """Random access to frames of a prepared pointcloud topic."""

    def __init__(self, prepared: Path, topic: str):
        tdir = prepared / "topics" / topic
        self.meta = topic_meta(prepared, topic)
        self.ts = np.fromfile(tdir / "timestamps.f64", "<f8")
        self.offsets = np.fromfile(tdir / "offsets.u64", "<u8")
        self.frames = np.memmap(tdir / "frames.bin", dtype=np.uint8, mode="r")
        self.scale = float(self.meta["positionScale"])

    def __len__(self):
        return len(self.ts)

    def points(self, i: int) -> np.ndarray:
        a, b = int(self.offsets[i]), int(self.offsets[i + 1])
        chunk = np.asarray(self.frames[a:b])
        n = int(chunk[:4].view("<u4")[0])
        return chunk[4 : 4 + n * 6].view("<i2").reshape(n, 3).astype(np.float64) * self.scale


# --- rigid transforms as 4x4 matrices ---------------------------------------------------------

def make_tf(translation, quat_xyzw) -> np.ndarray:
    T = np.eye(4)
    T[:3, :3] = Rotation.from_quat(quat_xyzw).as_matrix()
    T[:3, 3] = translation
    return T


def inv_tf(T: np.ndarray) -> np.ndarray:
    R, t = T[..., :3, :3], T[..., :3, 3]
    out = np.zeros_like(T)
    out[..., :3, :3] = np.swapaxes(R, -1, -2)
    out[..., :3, 3] = -np.einsum("...ji,...j->...i", R, t)
    out[..., 3, 3] = 1
    return out


def apply_tf(T: np.ndarray, pts: np.ndarray) -> np.ndarray:
    return pts @ T[:3, :3].T + T[:3, 3]


def yaw_of(T: np.ndarray) -> float:
    return float(np.arctan2(T[1, 0], T[0, 0]))


class StaticTf:
    """static/tf.json; `relative(a, b)` = T_a_b, mapping points in b into a (same as web TfTree)."""

    def __init__(self, prepared: Path):
        self.frames = json.loads((prepared / "static" / "tf.json").read_text())["frames"]

    def _from_root(self, frame: str) -> np.ndarray:
        t = self.frames.get(frame)
        if t is None:
            return np.eye(4)
        return self._from_root(t["parent"]) @ make_tf(t["translation"], t["rotationXyzw"])

    def relative(self, a: str, b: str) -> np.ndarray:
        return inv_tf(self._from_root(a)) @ self._from_root(b)


class PoseTrack:
    """Pose series (pose_pos.*, pose_orien.q*) interpolated at arbitrary times (lerp + slerp)."""

    def __init__(self, prepared: Path, topic: str):
        ts, c = read_series(prepared, topic)
        keep = np.r_[True, np.diff(ts) > 0]
        self.ts = ts[keep]
        self.pos = np.stack([c[f"pose_pos.{k}"] for k in "xyz"], 1)[keep]
        quat = np.stack([c[f"pose_orien.q{k}"] for k in "xyzw"], 1)[keep]
        self.slerp = Slerp(self.ts, Rotation.from_quat(quat))

    def covers(self, t: float) -> bool:
        return self.ts[0] <= t <= self.ts[-1]

    def at(self, t: float) -> np.ndarray:
        t = float(np.clip(t, self.ts[0], self.ts[-1]))
        T = np.eye(4)
        T[:3, :3] = self.slerp([t]).as_matrix()[0]
        T[:3, 3] = [np.interp(t, self.ts, self.pos[:, k]) for k in range(3)]
        return T
