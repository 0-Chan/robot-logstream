import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { PointCloudTopic, SeriesTopic } from "@grandtour/protocol";
import { Badge } from "@/components/ui/badge";
import { themeVarHex } from "@/lib/theme";
import { live } from "../data/live.ts";
import { TfTree } from "../data/tf.ts";
import { SERVER_URL } from "../net/client.ts";
import { WORLD_POSE_FRAME, WORLD_POSE_TOPIC, estimatePlayhead, useApp } from "../state.ts";
import { Notice, Panel } from "./Panel.tsx";

const MAX_TRAIL = 4000;

/**
 * Scene graph (ROS Z-up inside a root group rotated to three.js Y-up):
 *   world mode : root = DLIO map frame. Scan placed by T_map_hesai(t) * T_hesai_sensor.
 *   sensor mode: root = box_base.       Scan placed by T_box_sensor.
 */
export function Viewer3D() {
  const ui = useApp((s) => s.ui);
  const manifest = useApp((s) => s.manifest)!;
  const tfFile = useApp((s) => s.tf);
  const tf = useMemo(() => (tfFile ? new TfTree(tfFile) : null), [tfFile]);
  const lidar = manifest.topics.find((t) => t.name === ui.lidar && t.kind === "pointcloud") as PointCloudTopic | undefined;
  const pose = manifest.topics.find((t) => t.name === WORLD_POSE_TOPIC) as SeriesTopic | undefined;

  const background = useMemo(() => themeVarHex("--card"), []);

  // Explain why something is missing instead of silently hiding it.
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = estimatePlayhead();
      const notes: string[] = [];
      if (lidar) {
        if (!tf) notes.push("좌표 변환(TF) 불러오는 중…");
        else if (!tf.has(lidar.frameId)) notes.push(`좌표 변환 정보 없음: ${lidar.frameId}`);
        if (t < lidar.t0) notes.push("해당 시점 점군 데이터 없음 (첫 스캔 이전)");
        else if (!live.pointclouds.get(lidar.id)) notes.push("점군 수신 대기 중…");
      }
      if (ui.worldView && pose) {
        const buf = live.series.get(pose.id);
        if (t < pose.t0 || !buf || buf.indexAtOrBefore(t) < 0) notes.push("해당 시점 포즈 없음: 점군과 로봇을 맵에 배치할 수 없습니다");
      }
      const text = notes.join(" · ");
      if (notice.current && notice.current.textContent !== text) notice.current.textContent = text;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [lidar, pose, tf, ui.worldView]);

  return (
    <Panel
      className="h-full"
      title={`3D · ${ui.worldView ? "DLIO 맵 좌표계" : "센서 박스(box_base) 좌표계"}`}
      right={lidar && <Badge variant="secondary">{lidar.name}</Badge>}
    >
      {/* remount per mode so the camera starts from a sensible viewpoint in each frame */}
      <Canvas key={ui.worldView ? "world" : "sensor"} camera={{ position: ui.worldView ? [-8, 10, 8] : [-3, 3, 3], fov: 55, near: 0.05, far: 2000 }} dpr={[1, 2]}>
        <color attach="background" args={[background]} />
        <Scene lidar={lidar} pose={ui.worldView ? pose : undefined} showMap={ui.worldView && ui.showMap} tf={tf} />
      </Canvas>
      <Notice ref={notice} />
    </Panel>
  );
}

function Scene({ lidar, pose, showMap, tf }: { lidar?: PointCloudTopic; pose?: SeriesTopic; showMap: boolean; tf: TfTree | null }) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const robot = useRef<THREE.Group>(null);
  const scanGroup = useRef<THREE.Group>(null);
  const lastRobotPos = useRef<THREE.Vector3 | null>(null);
  const poseMatrix = useMemo(() => new THREE.Matrix4(), []);

  // T_hesai_box (robot marker) and T_hesai_sensor / T_box_sensor (scan mounting)
  const mount = useMemo(() => {
    if (!tf || !lidar) return null;
    const frame = lidar.frameId;
    if (!tf.has(frame)) return null;
    return pose ? tf.relative(WORLD_POSE_FRAME, frame) : tf.relative("box_base", frame);
  }, [tf, lidar, pose]);
  const hesaiToBox = useMemo(() => (tf ? tf.relative(WORLD_POSE_FRAME, "box_base") : new THREE.Matrix4()), [tf]);

  // pose columns
  const poseCols = useMemo(() => {
    if (!pose) return null;
    const idx = (n: string) => pose.columns.findIndex((c) => c.name === n);
    const cols = ["pose_pos.x", "pose_pos.y", "pose_pos.z", "pose_orien.qx", "pose_orien.qy", "pose_orien.qz", "pose_orien.qw"].map(idx);
    return cols.every((i) => i >= 0) ? { cols, offsets: cols.map((i) => pose.columns[i].offset) } : null;
  }, [pose]);

  const trailLine = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3));
    g.setDrawRange(0, 0);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: "#f2cc60" }));
  }, []);
  const trail = trailLine.geometry;

  useFrame(() => {
    const t = estimatePlayhead();
    // --- world pose (latest DLIO pose at or before playhead) ---
    let havePose = false;
    if (pose && poseCols) {
      const buf = live.series.get(pose.id);
      const i = buf ? buf.indexAtOrBefore(t) : -1;
      if (buf && i >= 0) {
        const r = buf.row(i);
        const v = poseCols.cols.map((c, k) => r[c] + poseCols.offsets[k]);
        poseMatrix.compose(new THREE.Vector3(v[0], v[1], v[2]), new THREE.Quaternion(v[3], v[4], v[5], v[6]), new THREE.Vector3(1, 1, 1));
        havePose = true;
        // trail: all buffered poses up to the playhead
        const pos = trail.getAttribute("position") as THREE.BufferAttribute;
        const start = Math.max(0, i + 1 - MAX_TRAIL);
        for (let k = start; k <= i; k++) {
          const row = buf.row(k);
          pos.setXYZ(k - start, row[poseCols.cols[0]] + poseCols.offsets[0], row[poseCols.cols[1]] + poseCols.offsets[1], row[poseCols.cols[2]] + poseCols.offsets[2]);
        }
        pos.needsUpdate = true;
        trail.setDrawRange(0, i + 1 - start);
      } else {
        trail.setDrawRange(0, 0);
      }
    }
    // --- robot marker (box_base) ---
    if (robot.current) {
      const m = pose ? (havePose ? poseMatrix.clone().multiply(hesaiToBox) : null) : new THREE.Matrix4();
      robot.current.visible = !!m;
      if (m) {
        robot.current.matrix.copy(m);
        // keep the camera following the robot in world mode
        const p = new THREE.Vector3().setFromMatrixPosition(m);
        if (pose && controls.current) {
          const pY = new THREE.Vector3(p.x, p.z, -p.y); // Z-up -> Y-up (root group rotation)
          // first pose: jump to the robot; afterwards: move camera and target along with it
          const dWorld = lastRobotPos.current ? pY.clone().sub(lastRobotPos.current) : pY.clone().sub(controls.current.target);
          controls.current.target.add(dWorld);
          controls.current.object.position.add(dWorld);
          lastRobotPos.current = pY;
        }
      }
    }
    // --- scan mounting ---
    if (scanGroup.current) {
      const m = mount ? (pose ? (havePose ? poseMatrix.clone().multiply(mount) : null) : mount) : null;
      scanGroup.current.visible = !!m;
      if (m) scanGroup.current.matrix.copy(m);
    }
  });

  useEffect(() => {
    lastRobotPos.current = null;
  }, [pose]);

  return (
    <>
      <OrbitControls ref={controls} makeDefault enableDamping />
      <ambientLight intensity={0.8} />
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <gridHelper args={[100, 100, "#3a3a3a", "#262626"]} rotation={[Math.PI / 2, 0, 0]} />
        {showMap && <StaticMap />}
        {pose && <primitive object={trailLine} />}
        <group ref={robot} matrixAutoUpdate={false}>
          <axesHelper args={[0.8]} />
          <mesh>
            <boxGeometry args={[0.6, 0.35, 0.2]} />
            <meshBasicMaterial color="#58a6ff" wireframe />
          </mesh>
        </group>
        <group ref={scanGroup} matrixAutoUpdate={false}>
          {lidar && <LivePoints topicId={lidar.id} />}
        </group>
      </group>
    </>
  );
}

function LivePoints({ topicId }: { topicId: number }) {
  const geom = useMemo(() => new THREE.BufferGeometry(), []);
  const shown = useRef(-1);
  useEffect(() => () => geom.dispose(), [geom]);
  useFrame(() => {
    const snap = live.pointclouds.get(topicId);
    if (!snap || snap.version === shown.current) return;
    geom.setAttribute("position", new THREE.BufferAttribute(snap.positions, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(snap.colors, 3, true));
    geom.computeBoundingSphere();
    shown.current = snap.version;
  });
  return (
    <points geometry={geom}>
      <pointsMaterial size={0.06} vertexColors sizeAttenuation />
    </points>
  );
}

function StaticMap() {
  const [geom, setGeom] = useState<THREE.BufferGeometry | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${SERVER_URL}/static/map.bin`)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (!alive) return;
        const n = new DataView(buf).getUint32(0, true);
        const xyz = new Float32Array(buf, 4, n * 3);
        const inten = new Uint8Array(buf, 4 + n * 12, n);
        const colors = new Uint8Array(n * 3);
        for (let i = 0; i < n; i++) {
          const g = 60 + (inten[i] * 150) / 255;
          colors[i * 3] = g;
          colors[i * 3 + 1] = g;
          colors[i * 3 + 2] = g + 20;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(xyz, 3));
        g.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));
        setGeom(g);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => () => geom?.dispose(), [geom]);
  if (!geom) return null;
  return (
    <points geometry={geom}>
      <pointsMaterial size={0.04} vertexColors sizeAttenuation transparent opacity={0.55} />
    </points>
  );
}
