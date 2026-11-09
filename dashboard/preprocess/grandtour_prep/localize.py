"""localize: track the robot through the recording using only the CAD model as the map.

    uv run localize --prepared ../../data/prepared/2024-11-02-17-10-25

For every LiDAR scan:
  1. predict  - previous estimate moved by the leg odometry (anymal_state_odometry) since then
  2. correct  - point-to-plane ICP of the scan against the CAD surfaces (static/cad.glb)
  3. judge    - too few scan points on the CAD, a poor fit or a jump away from the prediction
                means "lost": keep the prediction and flag it

Only the first pose comes from DLIO (like telling the robot where it starts). DLIO is used
afterwards only to score the result. Directions the visible CAD surfaces do not constrain (e.g.
along a long, featureless walkway) are not corrected and are counted in `constrainedDims`.

Writes the derived series topic topics/cad_localization (+ summary.json) and refreshes the manifest.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import open3d as o3d
import trimesh
from scipy.spatial.transform import Rotation

from .common import base_meta, write_meta, write_timestamps
from .prepared import PointCloudTopic, PoseTrack, StaticTf, apply_tf, inv_tf, yaw_of

TOPIC = "cad_localization"
COLUMNS = ["pose_orien.qx", "pose_orien.qy", "pose_orien.qz", "pose_orien.qw",
           "pose_pos.x", "pose_pos.y", "pose_pos.z",
           "fitness", "rmse", "lost", "constrainedDims", "correction",
           "err_pos", "err_yaw", "odom_err_pos"]


class CadSurface:
    def __init__(self, glb: Path):
        mesh = trimesh.util.concatenate(trimesh.load(glb, force="scene").dump())
        self.scene = o3d.t.geometry.RaycastingScene()
        self.scene.add_triangles(o3d.core.Tensor(np.asarray(mesh.vertices, np.float32)),
                                 o3d.core.Tensor(np.asarray(mesh.faces, np.uint32)))

    def closest(self, p: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        r = self.scene.compute_closest_points(o3d.core.Tensor(p.astype(np.float32)))
        return r["points"].numpy().astype(np.float64), r["primitive_normals"].numpy().astype(np.float64)


def voxel_downsample(p: np.ndarray, voxel: float) -> np.ndarray:
    _, first = np.unique(np.floor(p / voxel).astype(np.int64), axis=0, return_index=True)
    return p[first]


def icp(pred: np.ndarray, src: np.ndarray, cad: CadSurface, prior_info: np.ndarray,
        stages=(1.0, 0.5, 0.25), iters=8, sigma_point=0.2, huber=0.1):
    """Point-to-plane Gauss-Newton with the odometry prediction as a prior.

    Minimizes  sum_i w_i (n_i . (p_i - q_i))^2 / sigma_point^2  +  e^T prior_info e,
    where e = (rotation vector, translation) of the estimate relative to the prediction, with the
    rotation taken about the sensor position. Directions the CAD surfaces in view do not constrain
    (e.g. along a long walkway with no cross walls) therefore follow the odometry instead of
    sliding. Returns (T, fitness, rmse, constrained_dims) where constrained_dims counts the
    directions in which the CAD outweighs the prior.
    """
    T = pred.copy()
    dims = 0
    for dmax in stages:
        for _ in range(iters):
            P = apply_tf(T, src)
            q, n = cad.closest(P)
            m = np.linalg.norm(P - q, axis=1) < dmax
            if m.sum() < 30:
                return T, 0.0, np.inf, 0
            c = T[:3, 3]
            r = np.einsum("ij,ij->i", P[m] - q[m], n[m])
            J = np.hstack([np.cross(P[m] - c, n[m]), n[m]])
            w = np.minimum(1.0, huber / np.maximum(np.abs(r), 1e-9)) / sigma_point**2
            H = J.T @ (J * w[:, None])
            g = J.T @ (w * r)
            e = np.r_[Rotation.from_matrix(T[:3, :3] @ pred[:3, :3].T).as_rotvec(), c - pred[:3, 3]]
            delta = -np.linalg.solve(H + prior_info, g + prior_info @ e)
            s_inv = 1 / np.sqrt(np.diag(prior_info))
            dims = int((np.linalg.eigvalsh(H * np.outer(s_inv, s_inv)) > 1).sum())
            T_new = np.eye(4)
            T_new[:3, :3] = Rotation.from_rotvec(delta[:3]).as_matrix() @ T[:3, :3]
            T_new[:3, 3] = c + delta[3:]
            T = T_new
            if np.linalg.norm(delta[:3]) < 1e-4 and np.linalg.norm(delta[3:]) < 1e-3:
                break
    P = apply_tf(T, src)
    q, n = cad.closest(P)
    d = np.abs(np.einsum("ij,ij->i", P - q, n))
    inl = np.linalg.norm(P - q, axis=1) < stages[-1]
    rmse = float(np.sqrt(np.mean(d[inl] ** 2))) if inl.any() else np.inf
    return T, float(inl.mean()), rmse, dims


def pose_delta(A: np.ndarray, B: np.ndarray) -> tuple[float, float]:
    """Translation (m) and rotation (deg) between two poses."""
    D = inv_tf(A) @ B
    return float(np.linalg.norm(D[:3, 3])), float(np.degrees(Rotation.from_matrix(D[:3, :3]).magnitude()))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prepared", required=True, type=Path)
    ap.add_argument("--scan-topic", default="hesai_points_undistorted")
    ap.add_argument("--odom-topic", default="anymal_state_odometry")
    ap.add_argument("--voxel", type=float, default=0.25)
    ap.add_argument("--min-range", type=float, default=1.0, help="drop the robot's own body")
    ap.add_argument("--max-range", type=float, default=40.0)
    ap.add_argument("--min-fitness", type=float, default=0.15)
    ap.add_argument("--max-rmse", type=float, default=0.12)
    ap.add_argument("--sigma-point", type=float, default=0.2, help="m; trust in one scan point vs. the CAD")
    ap.add_argument("--odom-sigma", type=float, nargs=2, default=(0.02, 0.3), metavar=("M", "DEG"),
                    help="odometry uncertainty per scan (prior strength)")
    ap.add_argument("--max-jump", type=float, default=1.0, help="m; larger corrections are rejected")
    ap.add_argument("--init-noise", type=float, nargs=2, default=(0.0, 0.0), metavar=("M", "DEG"),
                    help="perturb the initial pose (robustness test)")
    ap.add_argument("--keep", type=float, default=1.0, help="random fraction of scan points to keep")
    ap.add_argument("--out-topic", default=TOPIC)
    args = ap.parse_args(argv)

    prepared = args.prepared.resolve()
    cad = CadSurface(prepared / "static" / "cad.glb")
    scans = PointCloudTopic(prepared, args.scan_topic)
    frame = scans.meta["frameId"]
    tf = StaticTf(prepared)
    T_sb = tf.relative(frame, "base")  # sensor <- base
    T_bs = inv_tf(T_sb)
    odom = PoseTrack(prepared, args.odom_topic)  # T_odom_base
    dlio = PoseTrack(prepared, "dlio_map_odometry")  # T_map_hesai (reference only)
    T_dlio_sensor = tf.relative("hesai_lidar", frame)
    rng = np.random.default_rng(0)
    sm, sdeg = args.odom_sigma
    prior_info = np.diag([1 / np.radians(sdeg) ** 2] * 3 + [1 / sm**2] * 3)

    idx = [i for i in range(len(scans)) if odom.covers(scans.ts[i]) and dlio.covers(scans.ts[i])]
    t_first = scans.ts[idx[0]]
    T = dlio.at(t_first) @ T_dlio_sensor
    if any(args.init_noise):
        m, deg = args.init_noise
        D = np.eye(4)
        D[:3, :3] = Rotation.from_euler("z", deg, degrees=True).as_matrix()
        D[:3, 3] = [m / np.sqrt(2), m / np.sqrt(2), 0]
        T = D @ T
    T_odo_start = T.copy()
    O_first = odom.at(t_first)
    O_prev = O_first

    rows, ts, start = [], [], time.time()
    for k, i in enumerate(idx):
        t = scans.ts[i]
        O = odom.at(t)
        pred = T @ T_sb @ inv_tf(O_prev) @ O @ T_bs
        O_prev = O

        p = scans.points(i)
        rr = np.linalg.norm(p, axis=1)
        p = p[(rr > args.min_range) & (rr < args.max_range)]
        if args.keep < 1:
            p = p[rng.random(len(p)) < args.keep]
        src = voxel_downsample(p, args.voxel)

        est, fitness, rmse, dims = icp(pred, src, cad, prior_info, sigma_point=args.sigma_point)
        jump, _ = pose_delta(pred, est)
        lost = fitness < args.min_fitness or rmse > args.max_rmse or jump > args.max_jump
        T = pred if lost else est

        ref = dlio.at(t) @ T_dlio_sensor
        odo = T_odo_start @ T_sb @ inv_tf(O_first) @ O @ T_bs
        err_yaw = np.degrees((yaw_of(T) - yaw_of(ref) + np.pi) % (2 * np.pi) - np.pi)
        q = Rotation.from_matrix(T[:3, :3]).as_quat()
        rows.append([*q, *T[:3, 3], fitness, min(rmse, 9.0), float(lost), dims, jump,
                     np.linalg.norm(T[:3, 3] - ref[:3, 3]), err_yaw, np.linalg.norm(odo[:3, 3] - ref[:3, 3])])
        ts.append(t)
        if k % 200 == 0:
            print(f"  {k}/{len(idx)} fit={fitness:.2f} rmse={rmse:.3f} dims={dims} "
                  f"err={rows[-1][12]:.2f} m odom-only={rows[-1][14]:.2f} m", flush=True)

    vals = np.array(rows)
    out_dir = prepared / "topics" / args.out_topic
    out_dir.mkdir(parents=True, exist_ok=True)
    vals.astype("<f4").tofile(out_dir / "values.f32")
    write_timestamps(out_dir, np.array(ts))

    err, lost = vals[:, 12], vals[:, 9] > 0
    summary = {
        "scans": len(ts), "seconds": round(time.time() - start, 1),
        "lostRatio": round(float(lost.mean()), 4),
        "errPos": {k: round(float(f(err)), 3) for k, f in
                   (("mean", np.mean), ("p95", lambda e: np.percentile(e, 95)), ("max", np.max))},
        "errYawAbsP95": round(float(np.percentile(np.abs(vals[:, 13]), 95)), 2),
        "odomOnlyErrPos": {"final": round(float(vals[-1, 14]), 3), "max": round(float(vals[:, 14].max()), 3)},
        "underconstrainedRatio": round(float((vals[:, 10] < 6).mean()), 4),
        "settings": {k: v for k, v in vars(args).items() if k != "prepared"} | {"scanTopic": args.scan_topic},
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1, default=str))

    attrs = {"frame_id": "dlio_map",
             "description": f"Pose of {frame} localized against the simple CAD map "
                            f"(leg odometry prediction + point-to-plane ICP). Derived, not recorded."}
    meta = base_meta(args.out_topic, "series", attrs, np.array(ts))
    meta.update({"columns": [{"name": c, "offset": 0.0} for c in COLUMNS], "droppedFields": [],
                 "derived": True, "poseOf": frame,
                 "files": {"timestamps": "timestamps.f64", "values": "values.f32"}})
    write_meta(out_dir, meta)

    from .cli import rebuild_manifest
    rebuild_manifest(prepared)
    print(json.dumps({k: v for k, v in summary.items() if k != "settings"}, indent=1))


if __name__ == "__main__":
    main()
