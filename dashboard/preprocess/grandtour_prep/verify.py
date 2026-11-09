"""verify: compare prepared output against the raw sequence on random samples.

    uv run verify --src ../../data/raw/2024-11-02-17-10-25
"""

from __future__ import annotations

import argparse
import io
import json
import struct
import sys
import tarfile
from pathlib import Path

import numpy as np
from PIL import Image

from .kinds.images import _members
from .kinds.series import column_names, sort_order
from .tarzarr import TarZarrGroup


def frame_bytes(tdir: Path, i: int) -> bytes:
    offs = np.fromfile(tdir / "offsets.u64", dtype="<u8")
    with open(tdir / "frames.bin", "rb") as f:
        f.seek(int(offs[i]))
        return f.read(int(offs[i + 1] - offs[i]))


def check_timestamps(meta: dict, tdir: Path, g: TarZarrGroup) -> list[str]:
    ts = np.fromfile(tdir / "timestamps.f64", dtype="<f8")
    raw = g.read("timestamp").astype(np.float64)
    if meta.get("sortedByTimestamp"):
        raw = raw[sort_order(raw)]
    errs = []
    if len(ts) != meta["count"] or not np.array_equal(ts, raw):
        errs.append("timestamps differ from raw")
    if np.any(np.diff(ts) < 0):
        errs.append("timestamps not monotonic")
    if meta["kind"] in ("pointcloud", "image", "depth"):
        offs = np.fromfile(tdir / "offsets.u64", dtype="<u8")
        if len(offs) != len(ts) + 1 or np.any(np.diff(offs.astype(np.int64)) <= 0):
            errs.append("offsets invalid")
    return errs


def check_pointcloud(meta, tdir, g, rng, samples) -> list[str]:
    errs = []
    valid = g.read("valid").reshape(-1)
    pts, inten = g.row_reader("points"), g.row_reader("intensity")
    scale = meta["positionScale"]
    for i in sorted(rng.choice(meta["count"], size=min(samples, meta["count"]), replace=False)):
        b = frame_bytes(tdir, int(i))
        n = struct.unpack_from("<I", b)[0]
        if len(b) != 4 + n * 7:
            errs.append(f"frame {i}: size mismatch")
            continue
        q = np.frombuffer(b, dtype="<i2", count=n * 3, offset=4).reshape(n, 3) * scale
        ref = pts[int(i)][: valid[i]]
        ref = ref[np.isfinite(ref).all(1) & (np.abs(np.round(ref / scale)) <= 32767).all(1)]
        if len(ref) != n:
            errs.append(f"frame {i}: {n} points, raw has {len(ref)} in range")
            continue
        err = np.abs(q - ref).max() if n else 0
        if err > scale / 2 + 1e-6:
            errs.append(f"frame {i}: max position error {err:.4f} m")
    return errs


def check_series(meta, tdir, g, rng, samples) -> list[str]:
    cols = meta["columns"]
    vals = np.fromfile(tdir / "values.f32", dtype="<f4").reshape(meta["count"], len(cols))
    errs = []
    order = sort_order(g.read("timestamp")) if meta.get("sortedByTimestamp") else None
    by_name = {}
    for field, info in g.arrays.items():
        if field in ("timestamp", "sequence_id"):
            continue
        for k, name in enumerate(column_names(field, info.shape)):
            by_name[name] = (field, k)
    cache = {}
    for ci, c in enumerate(cols):
        field, k = by_name[c["name"]]
        if field not in cache:
            a = g.read(field).astype(np.float64).reshape(meta["count"], -1)
            cache[field] = a[order] if order is not None else a
        ref = cache[field][:, k]
        got = vals[:, ci].astype(np.float64) + c["offset"]
        # float32 storage of (value - offset): relative error ~6e-8, allow 1e-6
        tol = 1e-6 * np.abs(ref - c["offset"]) + 1e-9
        bad = ~((np.abs(got - ref) <= tol) | (np.isnan(got) & np.isnan(ref)))
        if bad.any():
            errs.append(f"column {c['name']}: {int(bad.sum())} values off (max {np.nanmax(np.abs(got - ref)):.3g})")
    return errs


def check_images(meta, tdir, src, rng, samples) -> list[str]:
    errs = []
    with tarfile.open(src / "images" / f"{meta['name']}.tar") as tar:
        n_raw = len(_members(tar))
    if n_raw != meta["count"]:
        errs.append(f"{n_raw} raw images vs {meta['count']} frames")
    for i in rng.choice(meta["count"], size=min(samples, meta["count"]), replace=False):
        im = Image.open(io.BytesIO(frame_bytes(tdir, int(i))))
        if im.size != (meta["width"], meta["height"]):
            errs.append(f"frame {i}: size {im.size}")
        if meta["kind"] == "depth" and np.array(im).dtype != np.uint16:
            errs.append(f"frame {i}: depth not 16-bit")
    return errs


def check_derived(meta: dict, tdir: Path) -> list[str]:
    """Computed topics have no raw tar: check only that the files match the manifest entry."""
    ts = np.fromfile(tdir / "timestamps.f64", "<f8")
    vals = np.fromfile(tdir / "values.f32", "<f4")
    errs = []
    if len(ts) != meta["count"]:
        errs.append(f"{len(ts)} timestamps, manifest says {meta['count']}")
    if np.any(np.diff(ts) <= 0):
        errs.append("timestamps not strictly increasing")
    if vals.size != len(ts) * len(meta["columns"]):
        errs.append(f"values.f32 has {vals.size} floats, expected {len(ts)} x {len(meta['columns'])}")
    elif not np.isfinite(vals).all():
        errs.append("non-finite values")
    return errs


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--samples", type=int, default=8, help="random frames checked per frame topic")
    args = ap.parse_args(argv)
    src = args.src.resolve()
    out = (args.out or src.parent.parent / "prepared" / src.name).resolve()
    manifest = json.loads((out / "manifest.json").read_text())
    rng = np.random.default_rng(0)
    failed = 0
    for meta in manifest["topics"]:
        tdir = out / meta["dir"]
        if meta.get("derived"):
            errs = check_derived(meta, tdir)
            failed += bool(errs)
            print(f"{'ok' if not errs else 'FAIL':4s} {meta['name']:32s} {'derived':10s} n={meta['count']}")
            for e in errs[:5]:
                print(f"       - {e}")
            continue
        with TarZarrGroup(src / "data" / f"{meta['name']}.tar") as g:
            errs = check_timestamps(meta, tdir, g)
            if meta["kind"] == "pointcloud":
                errs += check_pointcloud(meta, tdir, g, rng, args.samples)
            elif meta["kind"] == "series":
                errs += check_series(meta, tdir, g, rng, args.samples)
            else:
                errs += check_images(meta, tdir, src, rng, args.samples)
        status = "ok" if not errs else "FAIL"
        failed += bool(errs)
        print(f"{status:4s} {meta['name']:32s} {meta['kind']:10s} n={meta['count']}")
        for e in errs[:5]:
            print(f"       - {e}")
    print(f"\n{len(manifest['topics']) - failed}/{len(manifest['topics'])} topics passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
