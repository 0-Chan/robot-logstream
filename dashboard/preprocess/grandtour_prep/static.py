"""Sequence-wide static assets: TF tree and the downsampled point cloud map."""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import yaml


def write_tf(src: Path, out: Path):
    tf = yaml.safe_load((src / "metadata" / "tf.yaml").read_text())
    frames = {}
    for child, t in tf.items():
        r, p = t["rotation"], t["translation"]
        frames[child] = {
            "parent": t["base_frame_id"],
            "translation": [p["x"], p["y"], p["z"]],
            "rotationXyzw": [r["x"], r["y"], r["z"], r["w"]],
        }
    (out / "tf.json").write_text(json.dumps({"frames": frames}, indent=1))
    return len(frames)


def read_ply_xyzi(path: Path) -> np.ndarray:
    with open(path, "rb") as f:
        header = []
        while True:
            line = f.readline().decode("ascii").strip()
            header.append(line)
            if line == "end_header":
                break
        if "format binary_little_endian 1.0" not in header:
            raise ValueError(f"{path}: unsupported PLY format")
        props = [l.split()[-1] for l in header if l.startswith("property")]
        if props != ["x", "y", "z", "intensity"] or not all(
            l.split()[1] == "float" for l in header if l.startswith("property")
        ):
            raise ValueError(f"{path}: unexpected properties {props}")
        n = int(next(l for l in header if l.startswith("element vertex")).split()[-1])
        return np.fromfile(f, dtype="<f4", count=n * 4).reshape(n, 4)


def write_map(src: Path, out: Path, voxel_m: float = 0.05) -> dict | None:
    plys = sorted((src / "point_cloud_maps").glob("*.ply"))
    if not plys:
        return None
    a = read_ply_xyzi(plys[0])
    a = a[np.isfinite(a).all(axis=1)]
    keys = np.floor(a[:, :3] / voxel_m).astype(np.int64)
    _, first = np.unique(keys, axis=0, return_index=True)
    a = a[np.sort(first)]
    inten = a[:, 3]
    p = float(np.percentile(inten, 99.5)) or 1.0
    i8 = np.clip(np.round(inten * 255.0 / p), 0, 255).astype(np.uint8)
    with open(out / "map.bin", "wb") as f:
        f.write(struct.pack("<I", len(a)))
        f.write(a[:, :3].astype("<f4").tobytes())
        f.write(i8.tobytes())
    lo, hi = a[:, :3].min(0), a[:, :3].max(0)
    return {"file": "map.bin", "source": plys[0].name, "points": int(len(a)), "voxel": voxel_m,
            "bboxMin": lo.tolist(), "bboxMax": hi.tolist(),
            # The map is built by DLIO, so it shares the world frame of dlio_map_odometry poses.
            "sameFrameAs": "dlio_map_odometry"}
