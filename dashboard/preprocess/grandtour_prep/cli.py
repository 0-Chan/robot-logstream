"""prep: convert one raw GrandTour sequence into the streamable `prepared/` layout.

    uv run prep --src ../../data/raw/2024-11-02-17-10-25
    uv run prep --src ... --topics hesai_points,hdr_front --force
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import yaml

from .common import META_FILE
from .kinds import images, pointcloud, series
from .static import write_map, write_tf

PROTOCOL_LAYOUT_VERSION = 1
DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "topics.yaml"


def load_jobs(config: dict) -> list[tuple[str, str, dict]]:
    jobs = []
    for kind in ("pointcloud", "image", "depth"):
        jobs += [(t, kind, {}) for t in config.get(kind) or []]
    jobs += [(t, "series", opts or {}) for t, opts in (config.get("series") or {}).items()]
    return jobs


def run_job(src: str, out: str, topic: str, kind: str, opts: dict, defaults: dict) -> tuple[str, float]:
    start = time.time()
    src_p, out_dir = Path(src), Path(out) / "topics" / topic
    if kind == "pointcloud":
        pointcloud.convert(src_p, out_dir, topic, opts, defaults)
    elif kind in ("image", "depth"):
        images.convert(src_p, out_dir, topic, kind, defaults)
    else:
        series.convert(src_p, out_dir, topic, opts, defaults)
    return topic, time.time() - start


def write_manifest(src: Path, out: Path, jobs, static_info: dict):
    topics = []
    for topic_id, (topic, kind, _) in enumerate(jobs):
        meta_path = out / "topics" / topic / META_FILE
        if not meta_path.exists():
            continue
        meta = json.loads(meta_path.read_text())
        meta["id"] = topic_id
        meta["dir"] = f"topics/{topic}"
        topics.append(meta)
    t0 = min(m["t0"] for m in topics if m["t0"] is not None)
    t1 = max(m["t1"] for m in topics if m["t1"] is not None)
    manifest = {
        "layoutVersion": PROTOCOL_LAYOUT_VERSION,
        "sequence": src.name,
        "t0": t0,
        "t1": t1,
        "quaternionOrder": "xyzw",
        "static": static_info,
        "topics": topics,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    return manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, type=Path, help="raw sequence dir (data/raw/<sequence>)")
    ap.add_argument("--out", type=Path, help="output dir (default: <src>/../../prepared/<sequence>)")
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("--topics", help="comma-separated subset of topics to (re)build")
    ap.add_argument("--force", action="store_true", help="rebuild topics that are already done")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args(argv)

    src = args.src.resolve()
    out = (args.out or src.parent.parent / "prepared" / src.name).resolve()
    config = yaml.safe_load(args.config.read_text())
    defaults = config["defaults"]
    jobs = load_jobs(config)
    selected = set(args.topics.split(",")) if args.topics else None
    if selected:
        unknown = selected - {t for t, _, _ in jobs}
        if unknown:
            sys.exit(f"unknown topics (not in {args.config.name}): {sorted(unknown)}")

    (out / "topics").mkdir(parents=True, exist_ok=True)
    (out / "static").mkdir(exist_ok=True)
    print(f"src: {src}\nout: {out}")

    todo = []
    for topic, kind, opts in jobs:
        if selected and topic not in selected:
            continue
        done = (out / "topics" / topic / META_FILE).exists()
        if done and not args.force:
            print(f"  skip {topic} (done)")
            continue
        todo.append((topic, kind, opts))

    failed = []
    # Biggest jobs first so the pool stays busy.
    order = {"depth": 0, "image": 1, "pointcloud": 2, "series": 3}
    todo.sort(key=lambda j: order[j[1]])
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(run_job, str(src), str(out), t, k, o, defaults): t for t, k, o in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            topic = futs[fut]
            try:
                _, sec = fut.result()
                print(f"  [{i}/{len(todo)}] {topic} done in {sec:.0f}s", flush=True)
            except Exception:
                failed.append(topic)
                print(f"  [{i}/{len(todo)}] {topic} FAILED\n{traceback.format_exc()}", flush=True)

    static_info = {"tf": "static/tf.json"}
    print(f"  tf frames: {write_tf(src, out / 'static')}")
    map_path = out / "static" / "map.bin"
    if not map_path.exists() or args.force:
        info = write_map(src, out / "static")
        if info:
            (out / "static" / "map.json").write_text(json.dumps(info, indent=1))
    if (out / "static" / "map.json").exists():
        static_info["map"] = json.loads((out / "static" / "map.json").read_text())
        static_info["map"]["file"] = "static/map.bin"

    manifest = write_manifest(src, out, jobs, static_info)
    print(f"manifest: {len(manifest['topics'])} topics, {manifest['t1'] - manifest['t0']:.1f}s")
    if failed:
        sys.exit(f"failed topics: {failed}")


if __name__ == "__main__":
    main()
