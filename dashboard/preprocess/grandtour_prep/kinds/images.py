"""Camera topics -> downscaled JPEG (color) or 16-bit PNG (depth) frames.

Pixels come from images/<topic>.tar (<topic>/NNNNNN.jpeg|png); timestamps from data/<topic>.tar,
matched by frame index.
"""

from __future__ import annotations

import io
import tarfile
from pathlib import Path

import numpy as np
from PIL import Image

from ..common import FramesWriter, base_meta, write_meta, write_timestamps, check_monotonic
from ..tarzarr import TarZarrGroup


def _members(tar: tarfile.TarFile) -> list[tarfile.TarInfo]:
    ms = [m for m in tar.getmembers() if m.isfile() and not m.name.rsplit("/", 1)[-1].startswith(".")]
    ms.sort(key=lambda m: int(m.name.rsplit("/", 1)[-1].split(".")[0]))
    return ms


def _target_size(w: int, h: int, max_side: int) -> tuple[int, int]:
    s = min(1.0, max_side / max(w, h))
    return max(1, round(w * s)), max(1, round(h * s))


def encode_color(raw: bytes, max_side: int, quality: int) -> tuple[bytes, tuple[int, int], tuple[int, int]]:
    im = Image.open(io.BytesIO(raw))
    orig = im.size
    size = _target_size(*orig, max_side)
    im.draft("RGB", size)  # fast DCT-domain downscale for JPEG input
    im = im.convert("RGB").resize(size, Image.Resampling.BILINEAR)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, optimize=False)
    return buf.getvalue(), orig, size


def encode_depth(raw: bytes, max_side: int) -> tuple[bytes, tuple[int, int], tuple[int, int]]:
    a = np.array(Image.open(io.BytesIO(raw)))
    if a.dtype != np.uint16:
        a = a.astype(np.uint16)
    h, w = a.shape[:2]
    tw, th = _target_size(w, h, max_side)
    # nearest neighbour: never blend depth values across edges
    rows = ((np.arange(th) + 0.5) * h / th).astype(int)
    cols = ((np.arange(tw) + 0.5) * w / tw).astype(int)
    small = np.ascontiguousarray(a[rows][:, cols])
    buf = io.BytesIO()
    Image.fromarray(small).save(buf, "PNG", compress_level=3)
    return buf.getvalue(), (w, h), (tw, th)


def convert(src: Path, out_dir: Path, topic: str, kind: str, defaults: dict) -> dict:
    with TarZarrGroup(src / "data" / f"{topic}.tar") as g:
        ts = g.read("timestamp").astype(np.float64)
        attrs = g.attrs
    check_monotonic(topic, ts)
    out_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(src / "images" / f"{topic}.tar") as tar:
        members = _members(tar)
        if len(members) != len(ts):
            raise ValueError(f"{topic}: {len(members)} images but {len(ts)} timestamps")
        w = FramesWriter(out_dir)
        orig = size = None
        for m in members:
            raw = tar.extractfile(m).read()
            if kind == "image":
                data, orig, size = encode_color(raw, defaults["image_max_side"], defaults["image_jpeg_quality"])
            else:
                data, orig, size = encode_depth(raw, defaults["depth_max_side"])
            w.add(data)
        nbytes = w.close()
    write_timestamps(out_dir, ts)
    meta = base_meta(topic, kind, attrs, ts)
    meta.update({
        "encoding": "jpeg" if kind == "image" else "png16",
        "width": size[0], "height": size[1],
        "originalWidth": orig[0], "originalHeight": orig[1],
        "scale": size[0] / orig[0],  # multiply K's fx, fy, cx, cy by this
        "cameraInfo": attrs.get("camera_info"),
        "bytes": nbytes,
        "files": {"timestamps": "timestamps.f64", "frames": "frames.bin", "offsets": "offsets.u64"},
    })
    if kind == "depth":
        meta["depthUnit"] = "mm (estimated, not confirmed by dataset docs)"
    write_meta(out_dir, meta)
    return meta
