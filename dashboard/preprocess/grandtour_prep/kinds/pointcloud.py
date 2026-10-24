"""LiDAR topics -> per-frame [u32 n][i16 xyz * n][u8 intensity * n], padding removed."""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

from ..common import FramesWriter, base_meta, check_monotonic, write_meta, write_timestamps
from ..tarzarr import TarZarrGroup

INT16_MAX = 32767


def encode_frame(pts: np.ndarray, inten: np.ndarray, scale_m: float, inten_scale: float) -> bytes:
    q = np.round(pts / scale_m)
    keep = np.isfinite(q).all(axis=1) & (np.abs(q) <= INT16_MAX).all(axis=1)
    q = q[keep].astype("<i2")
    i8 = np.clip(np.round(inten[keep] * inten_scale), 0, 255).astype(np.uint8)
    return struct.pack("<I", len(q)) + q.tobytes() + i8.tobytes()


def convert(src: Path, out_dir: Path, topic: str, opts: dict, defaults: dict) -> dict:
    scale_m = float(defaults["pointcloud_scale_m"])
    with TarZarrGroup(src / "data" / f"{topic}.tar") as g:
        ts = g.read("timestamp").astype(np.float64)
        check_monotonic(topic, ts)
        valid = g.read("valid").reshape(-1).astype(np.int64)
        points = g.row_reader("points")
        inten = g.row_reader("intensity")
        # Intensity -> u8 scale from the 99.5th percentile of a few early frames.
        sample = np.concatenate([inten[i][: valid[i]] for i in range(0, min(len(ts), 40), 4)])
        p = float(np.percentile(sample, 99.5)) if sample.size else 1.0
        inten_scale = 255.0 / p if p > 0 else 1.0

        out_dir.mkdir(parents=True, exist_ok=True)
        w = FramesWriter(out_dir)
        total = 0
        for i in range(len(ts)):
            n = int(valid[i])
            w.add(encode_frame(points[i][:n], inten[i][:n], scale_m, inten_scale))
            total += n
        nbytes = w.close()
        attrs = g.attrs
    write_timestamps(out_dir, ts)
    meta = base_meta(topic, "pointcloud", attrs, ts)
    meta.update({
        "positionScale": scale_m,
        "intensityScale": inten_scale,
        "meanPoints": round(total / max(len(ts), 1)),
        "bytes": nbytes,
        "files": {"timestamps": "timestamps.f64", "frames": "frames.bin", "offsets": "offsets.u64"},
    })
    write_meta(out_dir, meta)
    return meta
