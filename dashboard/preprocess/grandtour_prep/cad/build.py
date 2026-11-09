"""cad-build: turn cad/site.yaml into a real CAD file (STEP, millimetres) and a web mesh (GLB, metres).

    uv run cad-build --prepared ../../data/prepared/2024-11-02-17-10-25

Outputs
  <prepared>/cad/site.step     solids for every wall and slab (open it in FreeCAD, Fusion, ...)
  <prepared>/static/cad.glb    the same solids, tessellated; nodes named wall_NNN / slab_NNN
  <prepared>/static/cad.json   counts, bounding box and how well the model explains the map
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cadquery as cq
import numpy as np
import open3d as o3d
import trimesh
import yaml

from ..prepared import read_map

MM = 1000.0  # CAD convention: the STEP file is in millimetres, the dashboard works in metres


def wall_solid(w: dict) -> cq.Workplane:
    a, b = np.array(w["a"]) * MM, np.array(w["b"]) * MM
    length = float(np.linalg.norm(b - a))
    height = (w["z1"] - w["z0"]) * MM
    t = w["thickness"] * MM
    d = (b - a) / length
    right = np.array([d[1], -d[0]])
    centre = (a + b) / 2 + right * t / 2
    angle = float(np.degrees(np.arctan2(d[1], d[0])))
    return (
        cq.Workplane("XY")
        .box(length, t, height)
        .rotate((0, 0, 0), (0, 0, 1), angle)
        .translate((centre[0], centre[1], (w["z0"] + w["z1"]) / 2 * MM))
    )


def slab_solid(s: dict) -> cq.Workplane:
    t = s["thickness"] * MM
    z = s["z"] * MM - (t if s["side"] == "down" else 0.0)
    pts = [(x * MM, y * MM) for x, y in s["polygon"]]
    return cq.Workplane("XY", origin=(0, 0, z)).polyline(pts).close().extrude(t)


def tessellate(shape: cq.Shape, tol_mm: float) -> trimesh.Trimesh:
    verts, tris = shape.tessellate(tol_mm, 0.5)
    v = np.array([(p.x, p.y, p.z) for p in verts]) / MM
    return trimesh.Trimesh(v, np.array(tris), process=True)


def map_fit(meshes: list[trimesh.Trimesh], pts: np.ndarray) -> dict:
    """How much of the DLIO map lies on the CAD surfaces (distance to the nearest face)."""
    mesh = trimesh.util.concatenate(meshes)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(mesh.vertices, o3d.core.float32),
                        o3d.core.Tensor(mesh.faces, o3d.core.uint32))
    lo, hi = np.percentile(pts, 1, axis=0), np.percentile(pts, 99, axis=0)
    p = pts[((pts >= lo) & (pts <= hi)).all(1)]
    dist = scene.compute_distance(o3d.core.Tensor(p.astype(np.float32))).numpy()
    return {f"within{int(d * 100)}cm": round(float((dist < d).mean()), 3) for d in (0.05, 0.1, 0.25)} | {
        "medianDistance": round(float(np.median(dist)), 3), "points": int(len(p))}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prepared", required=True, type=Path)
    ap.add_argument("--site", type=Path, help="default: <prepared>/cad/site.yaml")
    args = ap.parse_args(argv)

    prepared = args.prepared.resolve()
    site = yaml.safe_load((args.site or prepared / "cad" / "site.yaml").read_text())
    parts = [(f"wall_{i:03d}", wall_solid(w)) for i, w in enumerate(site.get("walls") or [])]
    parts += [(f"slab_{i:03d}", slab_solid(s)) for i, s in enumerate(site.get("slabs") or [])]

    assy = cq.Assembly(name="site")
    for name, wp in parts:
        assy.add(wp, name=name, color=cq.Color(0.75, 0.78, 0.82) if name[0] == "w" else cq.Color(0.55, 0.6, 0.66))
    step = prepared / "cad" / "site.step"
    assy.export(str(step))  # STEP keeps the assembly tree and part names

    meshes = {name: tessellate(wp.val(), 1.0) for name, wp in parts}
    scene = trimesh.Scene()
    for name, m in meshes.items():
        scene.add_geometry(m, node_name=name, geom_name=name)
    (prepared / "static").mkdir(exist_ok=True)
    glb = prepared / "static" / "cad.glb"
    glb.write_bytes(scene.export(file_type="glb"))

    all_mesh = trimesh.util.concatenate(list(meshes.values()))
    info = {
        "file": "static/cad.glb",
        "step": "cad/site.step",
        "frame": site.get("frame", "dlio_map"),
        "walls": sum(n[0] == "w" for n in meshes),
        "slabs": sum(n[0] == "s" for n in meshes),
        "triangles": int(len(all_mesh.faces)),
        "bboxMin": [round(float(v), 3) for v in all_mesh.bounds[0]],
        "bboxMax": [round(float(v), 3) for v in all_mesh.bounds[1]],
        "mapFit": map_fit(list(meshes.values()), read_map(prepared)),
    }
    (prepared / "static" / "cad.json").write_text(json.dumps(info, indent=1))
    from ..cli import rebuild_manifest
    rebuild_manifest(prepared)
    print(f"{step} ({step.stat().st_size / 1e6:.1f} MB)\n{glb} ({glb.stat().st_size / 1e6:.2f} MB)")
    print(json.dumps(info["mapFit"]))


if __name__ == "__main__":
    main()
