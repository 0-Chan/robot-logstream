from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

META_FILE = "meta.json"  # written last; its presence marks a finished topic


def transform_from_attrs(attrs: dict) -> dict | None:
    """Static mounting transform from .zattrs, normalized to xyzw quaternion order."""
    tf = attrs.get("transform")
    if not tf:
        return None
    r, t = tf["rotation"], tf["translation"]
    return {
        "parent": tf["base_frame_id"],
        "child": tf["child_frame_id"],
        "translation": [t["x"], t["y"], t["z"]],
        "rotationXyzw": [r["x"], r["y"], r["z"], r["w"]],
    }


def base_meta(topic: str, kind: str, attrs: dict, ts: np.ndarray) -> dict:
    dur = float(ts[-1] - ts[0]) if len(ts) > 1 else 0.0
    return {
        "name": topic,
        "kind": kind,
        "count": int(len(ts)),
        "t0": float(ts[0]) if len(ts) else None,
        "t1": float(ts[-1]) if len(ts) else None,
        "hz": round((len(ts) - 1) / dur, 3) if dur > 0 else None,
        "frameId": attrs.get("frame_id", ""),
        "description": attrs.get("description", ""),
        "transform": transform_from_attrs(attrs),
    }


def write_timestamps(out_dir: Path, ts: np.ndarray):
    np.asarray(ts, dtype="<f8").tofile(out_dir / "timestamps.f64")


def write_meta(out_dir: Path, meta: dict):
    tmp = out_dir / (META_FILE + ".tmp")
    tmp.write_text(json.dumps(meta, indent=1))
    os.replace(tmp, out_dir / META_FILE)


class FramesWriter:
    """Concatenated variable-size frames + uint64 offsets (count + 1 entries)."""

    def __init__(self, out_dir: Path):
        self.f = open(out_dir / "frames.bin", "wb")
        self.offsets = [0]
        self.out_dir = out_dir

    def add(self, payload: bytes):
        self.f.write(payload)
        self.offsets.append(self.offsets[-1] + len(payload))

    def close(self):
        self.f.close()
        np.asarray(self.offsets, dtype="<u8").tofile(self.out_dir / "offsets.u64")
        return self.offsets[-1]


def check_monotonic(topic: str, ts: np.ndarray):
    if len(ts) > 1 and np.any(np.diff(ts) < 0):
        raise ValueError(f"{topic}: timestamps are not monotonic")
