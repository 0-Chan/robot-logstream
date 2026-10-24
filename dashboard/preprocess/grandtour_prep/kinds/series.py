"""Time series topics -> one float32 matrix (N x C) + per-column offsets."""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np

from ..common import base_meta, write_meta, write_timestamps
from ..tarzarr import TarZarrGroup

JOINTS = ["LF_HAA", "LF_HFE", "LF_KFE", "RF_HAA", "RF_HFE", "RF_KFE",
          "LH_HAA", "LH_HFE", "LH_KFE", "RH_HAA", "RH_HFE", "RH_KFE"]
SKIP_FIELDS = {"timestamp", "sequence_id"}
OFFSET_THRESHOLD = 100.0  # columns with |value| above this get a float64 offset subtracted


def column_names(field: str, shape: tuple[int, ...]) -> list[str]:
    if len(shape) == 1:
        return [field]
    width = int(np.prod(shape[1:]))
    if width == 3:
        return [f"{field}.x", f"{field}.y", f"{field}.z"]
    if width == 4 and re.search(r"orien|rotation", field):
        # Verified on this dataset: all quaternion arrays are stored x, y, z, w.
        return [f"{field}.qx", f"{field}.qy", f"{field}.qz", f"{field}.qw"]
    if width == 12 and field.startswith("joint_"):
        return [f"{field}.{j}" for j in JOINTS]
    return [f"{field}[{i}]" for i in range(width)]


def sort_order(ts: np.ndarray) -> np.ndarray | None:
    """Stable sort permutation if timestamps go backwards anywhere, else None."""
    if len(ts) > 1 and np.any(np.diff(ts) < 0):
        return np.argsort(ts, kind="stable")
    return None


def convert(src: Path, out_dir: Path, topic: str, opts: dict, defaults: dict) -> dict:
    include = re.compile(opts["include"]) if opts.get("include") else None
    exclude = re.compile(opts.get("exclude", defaults["series_exclude"]))
    with TarZarrGroup(src / "data" / f"{topic}.tar") as g:
        ts = g.read("timestamp").astype(np.float64)
        # Some topics (e.g. dlio_tf) contain a few out-of-order messages: sort, keep ties stable.
        order = sort_order(ts)
        if order is not None:
            ts = ts[order]
        cols: list[np.ndarray] = []
        columns: list[dict] = []
        dropped: list[str] = []
        for field in sorted(g.arrays):
            if field in SKIP_FIELDS:
                continue
            if include and not include.search(field):
                continue
            if exclude.search(field):
                continue
            a = g.read(field).astype(np.float64).reshape(len(ts), -1)
            if order is not None:
                a = a[order]
            if not np.any(a):
                dropped.append(field)  # e.g. IMUs that do not estimate orientation
                continue
            for name, col in zip(column_names(field, g.arrays[field].shape), a.T):
                finite = col[np.isfinite(col)]
                offset = 0.0
                if finite.size and np.abs(finite).max() > OFFSET_THRESHOLD:
                    offset = float(finite[0])
                cols.append(col - offset)
                columns.append({"name": name, "offset": offset})
        attrs = g.attrs
    out_dir.mkdir(parents=True, exist_ok=True)
    write_timestamps(out_dir, ts)
    np.stack(cols, axis=1).astype("<f4").tofile(out_dir / "values.f32")
    meta = base_meta(topic, "series", attrs, ts)
    meta.update({"columns": columns, "droppedFields": dropped, "sortedByTimestamp": order is not None,
                 "files": {"timestamps": "timestamps.f64", "values": "values.f32"}})
    write_meta(out_dir, meta)
    return meta
