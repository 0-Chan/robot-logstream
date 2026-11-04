import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { live } from "../data/live.ts";
import { isDrawable, selectSample } from "../data/select.ts";
import { estimatePlayhead, useApp } from "../state.ts";
import { Empty, Notice, Panel } from "./Panel.tsx";
import { ageText, noticeText } from "./sampleStatus.ts";

export function CameraPanel({ slot }: { slot: 0 | 1 }) {
  const name = useApp((s) => s.ui.cameras[slot]);
  const manifest = useApp((s) => s.manifest);
  const topic = manifest?.topics.find((t) => t.name === name);
  const canvas = useRef<HTMLCanvasElement>(null);
  const age = useRef<HTMLSpanElement>(null);
  const notice = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!topic) return;
    let raf = 0;
    let drawn = -1;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      if (!c) return;
      const t = estimatePlayhead();
      const snap = live.images.get(topic.id);
      const sel = selectSample(snap?.t, t, { hz: topic.hz, connected: useApp.getState().status === "open" });
      const visible = !!snap && isDrawable(sel.state);

      // Only ever show a frame the selection rule allows; otherwise blank the canvas.
      c.style.visibility = visible ? "visible" : "hidden";
      c.style.opacity = sel.state === "ok" ? "1" : "0.55";
      if (visible) {
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
        live.recordDraw(snap, t);
      }

      const note = noticeText(sel, { beforeStart: t < topic.t0, moving: live.moving(), noun: "프레임" });
      if (notice.current && notice.current.textContent !== note) notice.current.textContent = note;
      if (age.current) {
        age.current.textContent = ageText(sel);
        age.current.dataset.stale = String(sel.state === "stale");
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
            재생 시각과 표시 중인 프레임의 센서 타임스탬프 차이입니다(네트워크 지연이 아님). 센서 주기의 3배(최소
            0.3초)를 넘으면 노란색 "이전 샘플"로 바뀌고, 2초를 넘으면 표시하지 않습니다. 재생 시각보다 뒤의 프레임은 절대
            표시하지 않습니다.
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
