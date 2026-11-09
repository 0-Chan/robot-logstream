import numpy as np
import trimesh
from scipy.spatial.transform import Rotation

from grandtour_prep.cad.build import MM, slab_solid, tessellate, wall_solid
from grandtour_prep.cad.extract import cover_rectangles, largest_rectangle
from grandtour_prep.localize import CadSurface, icp
from grandtour_prep.prepared import apply_tf, inv_tf


def bounds(wp):
    bb = wp.val().BoundingBox()
    return np.round(np.array([[bb.xmin, bb.ymin, bb.zmin], [bb.xmax, bb.ymax, bb.zmax]]) / MM, 3)


def test_wall_material_is_right_of_a_to_b():
    w = {"a": [0, 0], "b": [4, 0], "z0": 0, "z1": 3, "thickness": 0.2}
    np.testing.assert_allclose(bounds(wall_solid(w)), [[0, -0.2, 0], [4, 0, 3]], atol=1e-3)


def test_slab_side_sets_which_way_the_thickness_goes():
    poly = [[0, 0], [2, 0], [2, 1], [0, 1]]
    floor = slab_solid({"polygon": poly, "z": 1.0, "side": "down", "thickness": 0.2})
    ceiling = slab_solid({"polygon": poly, "z": 3.0, "side": "up", "thickness": 0.2})
    np.testing.assert_allclose(bounds(floor)[:, 2], [0.8, 1.0], atol=1e-3)
    np.testing.assert_allclose(bounds(ceiling)[:, 2], [3.0, 3.2], atol=1e-3)


def test_rectangle_cover_finds_the_two_parts_of_an_l_shape():
    g = np.zeros((10, 10), bool)
    g[0:3, 0:10] = True   # 30 cells
    g[3:10, 0:3] = True   # 21 cells
    assert largest_rectangle(g)[0] == 30
    rects = cover_rectangles(g, min_cells=4, max_rects=5)
    assert sum((r1 - r0) * (c1 - c0) for r0, c0, r1, c1 in rects) == g.sum()


def room(tmp_path):
    """6 x 4 x 3 m room (inner faces at x 0..6, y 0..4) with an extra pillar so yaw is observable."""
    walls = [
        {"a": [0, 4], "b": [0, 0]}, {"a": [0, 0], "b": [6, 0]},
        {"a": [6, 0], "b": [6, 4]}, {"a": [6, 4], "b": [0, 4]},
        {"a": [4, 1], "b": [4, 2]},
    ]
    parts = [wall_solid(w | {"z0": 0, "z1": 3, "thickness": 0.2}) for w in walls]
    parts.append(slab_solid({"polygon": [[0, 0], [6, 0], [6, 4], [0, 4]], "z": 0, "side": "down",
                             "thickness": 0.2}))
    meshes = [tessellate(p.val(), 1.0) for p in parts]
    path = tmp_path / "room.glb"
    scene = trimesh.Scene()
    for i, m in enumerate(meshes):
        scene.add_geometry(m, node_name=f"p{i}")
    path.write_bytes(scene.export(file_type="glb"))
    return path, trimesh.util.concatenate(meshes)


def test_icp_recovers_a_known_pose_in_a_synthetic_room(tmp_path):
    path, mesh = room(tmp_path)
    cad = CadSurface(path)
    world_pts = mesh.sample(6000, seed=1)
    true = np.eye(4)
    true[:3, :3] = Rotation.from_euler("z", 20, degrees=True).as_matrix()
    true[:3, 3] = [2.0, 2.5, 0.6]
    scan = apply_tf(inv_tf(true), world_pts)  # what the sensor sees, in the sensor frame
    pred = np.eye(4)
    pred[:3, :3] = Rotation.from_euler("z", 25, degrees=True).as_matrix()
    pred[:3, 3] = [2.25, 2.3, 0.6]
    weak_prior = np.diag([1.0] * 6)  # trust the CAD fully here
    est, fitness, rmse, dims = icp(pred, scan, cad, weak_prior)
    assert np.linalg.norm(est[:3, 3] - true[:3, 3]) < 0.02
    assert np.degrees(Rotation.from_matrix(est[:3, :3] @ true[:3, :3].T).magnitude()) < 0.3
    assert fitness > 0.95 and dims == 6
