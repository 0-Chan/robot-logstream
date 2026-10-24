import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { live } from "../data/live.ts";
import { estimatePlayhead, useApp } from "../state.ts";
import { Empty, Notice, Panel } from "./Panel.tsx";

/** A frame older than this many sensor periods (or 0.3 s) counts as a stale "previous sample". */
const STALE_PERIODS = 3;

export function CameraPanel({ slot }: { slot: 0 | 1 }) {
  const name = useApp((s) => s.ui.cameras[slot]);
  const manifest = useApp((s) => s.manifest);
  const topic = manifest?.topics.find((t) => t.name === name);
  const canvas = useRef<HTMLCanvasElement>(null);
  const age = useRef<HTMLSpanElement>(null);
  const notice = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!topic) return;
    const staleSec = Math.max(0.3, topic.hz ? STALE_PERIODS / topic.hz : 0.3);
    let raf = 0;
    let drawn = -1;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const t = estimatePlayhead();
      const snap = live.images.get(topic.id);
      const c = canvas.current;
      // what to tell the user about this panel right now
      let note = "";
      if (t < topic.t0) note = "해당 시점 데이터 없음 (첫 프레임 이전)";
      else if (!snap) note = "프레임 수신 대기 중…";
      if (notice.current && notice.current.textContent !== note) notice.current.textContent = note;
      if (c) c.style.visibility = t < topic.t0 ? "hidden" : "visible";
      if (!snap || !c) {
        if (age.current) age.current.textContent = "샘플 없음";
        return;
      }
      if (snap.version !== drawn) {
        if (c.width !== snap.bitmap.width || c.height !== snap.bitmap.height) {
          c.width = snap.bitmap.width;
          c.height = snap.bitmap.height;
        }
        const ctx = c.getContext("2d")!;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(snap.bitmap, 0, 0);
        drawn = snap.version;
      }
      if (age.current) {
        const sec = t - snap.t;
        age.current.textContent = `샘플 경과 ${Math.max(0, sec * 1000).toFixed(0)} ms`;
        age.current.dataset.stale = String(sec > staleSec);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [topic]);

  if (!topic) {
    return (
      <Panel>
        <Empty>카메라를 선택하세요</Empty>
      </Panel>
    );
  }
  const size = topic.kind === "image" || topic.kind === "depth" ? ` · ${topic.width}×${topic.height}` : "";
  return (
    <Panel
      title={`${topic.name}${size}`}
      right={
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              ref={age}
              variant="secondary"
              className="pointer-events-auto tabular-nums data-[stale=true]:bg-amber-500/20 data-[stale=true]:text-amber-300"
            >
              샘플 없음
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            재생 시각과 표시 중인 프레임의 센서 타임스탬프 차이입니다(네트워크 지연이 아님). 센서 주기의 {STALE_PERIODS}배를
            넘으면 노란색으로 바뀌며, 이전 샘플을 보여 주는 중이라는 뜻입니다.
          </TooltipContent>
        </Tooltip>
      }
    >
      <canvas ref={canvas} className="camera-canvas" />
      <Notice ref={notice} />
      {topic.kind === "depth" && (
        <Badge variant="secondary" className="absolute bottom-2 left-2 font-normal">
          깊이 0.3 m (파랑) → 8 m (빨강) · 단위 mm 추정
        </Badge>
      )}
    </Panel>
  );
}
