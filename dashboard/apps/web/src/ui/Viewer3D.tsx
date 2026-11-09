import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { PointCloudTopic, SeriesTopic } from "@grandtour/protocol";
import { Badge } from "@/components/ui/badge";
import { themeVarHex } from "@/lib/theme";
import { live, type SeriesBuffer } from "../data/live.ts";
import { isDrawable, maxAgeFor, selectSample } from "../data/select.ts";
import { TfTree } from "../data/tf.ts";
import { SERVER_URL } from "../net/client.ts";
import { CAD_POSE_TOPIC, WORLD_POSE_FRAME, WORLD_POSE_TOPIC, estimatePlayhead, useApp, type MapMode } from "../state.ts";
import { Notice, Panel } from "./Panel.tsx";
import { noticeText } from "./sampleStatus.ts";

const MAX_TRAIL = 4000;
/** CAD walls/ceilings above this height over the robot are cut away so they do not hide it. */
const CAD_CLIP_ABOVE_ROBOT_M = 1.5;
const POSE_COLUMNS = ["pose_pos.x", "pose_pos.y", "pose_pos.z", "pose_orien.qx", "pose_orien.qy", "pose_orien.qz", "pose_orien.qw"];

type PoseColumns = { cols: number[]; offsets: number[] };

function poseColumns(topic?: SeriesTopic): PoseColumns | null {
  if (!topic) return null;
  const cols = POSE_COLUMNS.map((n) => topic.columns.findIndex((c) => c.name === n));
  return cols.every((i) => i >= 0) ? { cols, offsets: cols.map((i) => topic.columns[i].offset) } : null;
}

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
  const cadPose = manifest.topics.find((t) => t.name === CAD_POSE_TOPIC) as SeriesTopic | undefined;
  const showCadPose = ui.worldView && ui.showCadPose && !!cadPose;
  const mapMode: MapMode = ui.worldView ? (manifest.static.cad ? ui.mapMode : ui.mapMode === "none" ? "none" : "points") : "none";

  const background = useMemo(() => themeVarHex("--card"), []);

  // Explain why something is missing instead of silently hiding it.
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = estimatePlayhead();
      const connected = useApp.getState().status === "open";
      const notes: string[] = [];
      if (!connected) notes.push(noticeText({ state: "disconnected", age: NaN }, { beforeStart: false, moving: false, noun: "" }));
      if (lidar) {
        if (!tf) notes.push("좌표 변환(TF) 불러오는 중…");
        else if (!tf.has(lidar.frameId)) notes.push(`좌표 변환 정보 없음: ${lidar.frameId}`);
        const snap = live.pointclouds.get(lidar.id);
        const sel = selectSample(snap?.t, t, { hz: lidar.hz, connected });
        if (connected) {
          const note = noticeText(sel, { beforeStart: t < lidar.t0, moving: live.moving(), noun: "점군" });
          if (note) notes.push(note);
          else if (sel.state === "stale") notes.push(`이전 점군 표시 중 (${(sel.age * 1000).toFixed(0)} ms 전)`);
        }
      }
      if (connected && ui.worldView && pose) {
        const buf = live.series.get(pose.id);
        const i = buf ? buf.indexAtOrBefore(t) : -1;
        const sel = selectSample(buf && i >= 0 ? buf.ts[i] : undefined, t, { hz: pose.hz, connected });
        if (!isDrawable(sel.state)) notes.push("해당 시점 포즈 없음: 점군과 로봇을 맵에 배치할 수 없습니다");
      }
      if (connected && showCadPose && cadPose) {
        const buf = live.series.get(cadPose.id);
        const i = buf ? buf.indexAtOrBefore(t) : -1;
        const sel = selectSample(buf && i >= 0 ? buf.ts[i] : undefined, t, { hz: cadPose.hz, connected });
        const lostCol = cadPose.columns.findIndex((c) => c.name === "lost");
        if (!isDrawable(sel.state)) notes.push("해당 시점 CAD 위치 추정 없음");
        else if (buf && lostCol >= 0 && buf.row(i)[lostCol] > 0) notes.push("CAD 위치 추정 실패 구간: 오도메트리 예측만 표시");
      }
      const text = notes.join(" · ");
      if (notice.current && notice.current.textContent !== text) notice.current.textContent = text;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [lidar, pose, cadPose, showCadPose, tf, ui.worldView]);

  return (
    <Panel
      className="h-full"
      title={`3D · ${ui.worldView ? "DLIO 맵 좌표계" : "센서 박스(box_base) 좌표계"}`}
      right={
        <div className="flex gap-1.5">
          {showCadPose && (
            <Badge variant="outline" className="gap-1.5 font-normal">
              <span className="inline-block size-2 rounded-full bg-[#58a6ff]" />
              DLIO
              <span className="ml-1 inline-block size-2 rounded-full bg-[#ff9f43]" />
              CAD 추정
            </Badge>
          )}
          {lidar && <Badge variant="secondary">{lidar.name}</Badge>}
        </div>
      }
    >
      {/* remount per mode so the camera starts from a sensible viewpoint in each frame */}
      <Canvas
        key={ui.worldView ? "world" : "sensor"}
        camera={{ position: ui.worldView ? [-8, 10, 8] : [-3, 3, 3], fov: 55, near: 0.05, far: 2000 }}
        dpr={[1, 2]}
        gl={{ localClippingEnabled: true }}
      >
        <color attach="background" args={[background]} />
        <Scene
          lidar={lidar}
          pose={ui.worldView ? pose : undefined}
          cadPose={showCadPose ? cadPose : undefined}
          mapMode={mapMode}
          cadFile={manifest.static.cad?.file}
          tf={tf}
        />
      </Canvas>
      <Notice ref={notice} />
    </Panel>
  );
}

function Scene({
  lidar,
  pose,
  cadPose,
  mapMode,
  cadFile,
  tf,
}: {
  lidar?: PointCloudTopic;
  pose?: SeriesTopic;
  cadPose?: SeriesTopic;
  mapMode: MapMode;
  cadFile?: string;
  tf: TfTree | null;
}) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const robot = useRef<THREE.Group>(null);
  const cadRobot = useRef<THREE.Group>(null);
  const cadRobotMaterial = useMemo(() => new THREE.MeshBasicMaterial({ color: "#ff9f43", wireframe: true }), []);
  const cadPoseMatrix = useMemo(() => new THREE.Matrix4(), []);
  // three.js world is Y-up (after the root group's rotation); keep y <= robot height + margin.
  const clip = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), Infinity), []);
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

  const poseCols = useMemo(() => poseColumns(pose), [pose]);
  const cadCols = useMemo(() => poseColumns(cadPose), [cadPose]);
  const cadLostCol = useMemo(() => cadPose?.columns.findIndex((c) => c.name === "lost") ?? -1, [cadPose]);

  const trailLine = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3));
    g.setDrawRange(0, 0);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: "#f2cc60" }));
  }, []);
  const trail = trailLine.geometry;

  const scanGeom = useMemo(() => new THREE.BufferGeometry(), []);
  useEffect(() => () => scanGeom.dispose(), [scanGeom]);
  const shownScan = useRef(-1);
  const scanPose = useMemo(() => new THREE.Matrix4(), []);

  useFrame(() => {
    const t = estimatePlayhead();
    const connected = useApp.getState().status === "open";
    const buf = pose ? live.series.get(pose.id) : undefined;

    // --- world pose at the playhead (robot marker, trail, camera follow) ---
    let havePose = false;
    if (pose && poseCols && buf) {
      const i = buf.indexAtOrBefore(t);
      const sel = selectSample(i >= 0 ? buf.ts[i] : undefined, t, { hz: pose.hz, connected });
      if (i >= 0 && isDrawable(sel.state)) {
        havePose = poseAt(buf, poseCols, t, maxAgeFor(pose.hz), poseMatrix);
        // trail: buffered poses up to the playhead
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
    // --- second marker: the same sensor pose, localized against the CAD model ---
    if (cadRobot.current) {
      const cbuf = cadPose ? live.series.get(cadPose.id) : undefined;
      let show = false;
      if (cadPose && cadCols && cbuf) {
        const i = cbuf.indexAtOrBefore(t);
        const sel = selectSample(i >= 0 ? cbuf.ts[i] : undefined, t, { hz: cadPose.hz, connected });
        if (i >= 0 && isDrawable(sel.state) && poseAt(cbuf, cadCols, t, maxAgeFor(cadPose.hz), cadPoseMatrix)) {
          show = true;
          cadRobot.current.matrix.copy(cadPoseMatrix).multiply(hesaiToBox);
          cadRobotMaterial.color.set(cadLostCol >= 0 && cbuf.row(i)[cadLostCol] > 0 ? "#f85149" : "#ff9f43");
        }
      }
      cadRobot.current.visible = show;
    }
    // --- robot marker (box_base) ---
    if (robot.current) {
      const m = pose ? (havePose ? poseMatrix.clone().multiply(hesaiToBox) : null) : new THREE.Matrix4();
      robot.current.visible = !!m;
      clip.constant = m && pose ? m.elements[14] + CAD_CLIP_ABOVE_ROBOT_M : Infinity;
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
    // --- scan: only if the selection rule allows it, placed with the pose at the SCAN's timestamp ---
    if (scanGroup.current) {
      const snap = lidar ? live.pointclouds.get(lidar.id) : undefined;
      const sel = selectSample(snap?.t, t, { hz: lidar?.hz ?? null, connected });
      let m: THREE.Matrix4 | null = null;
      if (snap && mount && isDrawable(sel.state)) {
        if (!pose) m = mount;
        else if (buf && poseCols && poseAt(buf, poseCols, snap.t, maxAgeFor(pose.hz), scanPose)) m = scanPose.clone().multiply(mount);
      }
      scanGroup.current.visible = !!m;
      if (m && snap) {
        scanGroup.current.matrix.copy(m);
        if (snap.version !== shownScan.current) {
          scanGeom.setAttribute("position", new THREE.BufferAttribute(snap.positions, 3));
          scanGeom.setAttribute("color", new THREE.BufferAttribute(snap.colors, 3, true));
          scanGeom.computeBoundingSphere();
          shownScan.current = snap.version;
        }
        live.recordDraw(snap, t);
      }
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
        {(mapMode === "points" || mapMode === "both") && <StaticMap />}
        {(mapMode === "cad" || mapMode === "both") && cadFile && <CadMap file={cadFile} clip={clip} overlay={mapMode === "both"} />}
        {pose && <primitive object={trailLine} />}
        <group ref={robot} matrixAutoUpdate={false}>
          <axesHelper args={[0.8]} />
          <mesh>
            <boxGeometry args={[0.6, 0.35, 0.2]} />
            <meshBasicMaterial color="#58a6ff" wireframe />
          </mesh>
        </group>
        <group ref={cadRobot} matrixAutoUpdate={false} visible={false}>
          <axesHelper args={[0.5]} />
          <mesh material={cadRobotMaterial}>
            <boxGeometry args={[0.6, 0.35, 0.2]} />
          </mesh>
        </group>
        <group ref={scanGroup} matrixAutoUpdate={false}>
          <points geometry={scanGeom}>
            <pointsMaterial size={0.06} vertexColors sizeAttenuation />
          </points>
        </group>
      </group>
    </>
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

/**
 * Simple CAD model (static/cad.glb, Z-up metres in the DLIO map frame): translucent faces plus edges.
 * Everything above the robot by CAD_CLIP_ABOVE_ROBOT_M is clipped so ceilings and walkways overhead
 * do not hide it.
 */
function CadMap({ file, clip, overlay }: { file: string; clip: THREE.Plane; overlay: boolean }) {
  const [model, setModel] = useState<THREE.Group | null>(null);
  useEffect(() => {
    let alive = true;
    let group: THREE.Group | null = null;
    new GLTFLoader().load(`${SERVER_URL}/${file}`, (gltf) => {
      if (!alive) return;
      group = new THREE.Group();
      // Walls are what pins the robot horizontally, so they stand out; floors and ceilings stay faint.
      const style = (wall: boolean) => ({
        faces: new THREE.MeshBasicMaterial({
          color: wall ? "#9fb3c8" : "#6e7b88",
          transparent: true,
          opacity: (wall ? 0.22 : 0.07) * (overlay ? 0.6 : 1),
          side: THREE.DoubleSide,
          depthWrite: false,
          clippingPlanes: [clip],
        }),
        edges: new THREE.LineBasicMaterial({ color: wall ? "#c3d2e0" : "#7d8a97", transparent: true, opacity: wall ? 0.8 : 0.3, clippingPlanes: [clip] }),
      });
      const styles = { wall: style(true), slab: style(false) };
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const { faces, edges } = /wall/.test(o.name + (o.parent?.name ?? "")) ? styles.wall : styles.slab;
        const geom = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
        group!.add(new THREE.Mesh(geom, faces));
        group!.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom, 30), edges));
      });
      setModel(group);
    });
    return () => {
      alive = false;
      const materials = new Set<THREE.Material>();
      group?.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          materials.add(o.material as THREE.Material);
        }
      });
      materials.forEach((m) => m.dispose());
    };
  }, [file, clip, overlay]);
  return model ? <primitive object={model} /> : null;
}

/**
 * Pose (T_map_hesai) at time t. Interpolates between the surrounding samples (lerp + slerp) when they
 * are close together; otherwise uses the last sample only if it is recent enough. Fails rather than
 * guessing: no placement is better than a scan drawn at the wrong place.
 */
function poseAt(
  buf: SeriesBuffer,
  pc: PoseColumns,
  t: number,
  maxGap: number,
  out: THREE.Matrix4,
): boolean {
  const i = buf.indexAtOrBefore(t);
  if (i < 0) return false;
  const read = (k: number) => pc.cols.map((c, j) => buf.row(k)[c] + pc.offsets[j]);
  const a = read(i);
  const p = new THREE.Vector3(a[0], a[1], a[2]);
  const q = new THREE.Quaternion(a[3], a[4], a[5], a[6]);
  const j = i + 1;
  if (j < buf.length && buf.ts[j] - buf.ts[i] <= maxGap) {
    const b = read(j);
    const u = (t - buf.ts[i]) / (buf.ts[j] - buf.ts[i]);
    p.lerp(new THREE.Vector3(b[0], b[1], b[2]), u);
    q.slerp(new THREE.Quaternion(b[3], b[4], b[5], b[6]), u);
  } else if (t - buf.ts[i] > maxGap) {
    return false;
  }
  out.compose(p, q, new THREE.Vector3(1, 1, 1));
  return true;
}
