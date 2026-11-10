import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { live } from "../data/live.ts";
import { RateMeter } from "../data/rate.ts";
import { isDrawable, selectSample } from "../data/select.ts";
import { estimatePlayhead, useApp } from "../state.ts";
import { Empty, Notice, Panel } from "./Panel.tsx";
import { dotState, noticeText, rateText } from "./sampleStatus.ts";

const LABEL_REFRESH_MS = 500;

export function CameraPanel({ slot }: { slot: 0 | 1 }) {
  const name = useApp((s) => s.ui.cameras[slot]);
  const manifest = useApp((s) => s.manifest);
  const topic = manifest?.topics.find((t) => t.name === name);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  const rateLabel = useRef<HTMLSpanElement>(null);
  const notice = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!topic) return;
    let raf = 0;
    let drawn = -1;
    // Measured draw rate; the label changes at most every LABEL_REFRESH_MS so the number stays readable.
    const meter = new RateMeter();
    let meterEpoch = live.epoch;
    let labelAt = -Infinity;
    let labelKey = "";
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      if (!c) return;
      const t = estimatePlayhead();
      const now = performance.now();
      if (live.epoch !== meterEpoch) {
        meter.reset();
        meterEpoch = live.epoch;
      }
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
          meter.tick(now);
        }
        live.recordDraw(snap, t);
      }

      const note = noticeText(sel, { beforeStart: t < topic.t0, moving: live.moving(), noun: "프레임" });
      if (notice.current && notice.current.textContent !== note) notice.current.textContent = note;
      const state = dotState(sel);
      if (dot.current && dot.current.dataset.state !== state) dot.current.dataset.state = state;
      const playing = useApp.getState().clock.playing;
      const key = `${state}:${playing}`;
      if (rateLabel.current && (key !== labelKey || now - labelAt >= LABEL_REFRESH_MS)) {
        rateLabel.current.textContent = rateText(meter.rate(now), sel, playing);
        labelKey = key;
        labelAt = now;
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
            <Badge variant="secondary" className="pointer-events-auto tabular-nums">
              <span
                ref={dot}
                data-state="none"
                className="size-2 rounded-full bg-muted-foreground/50 data-[state=off]:bg-red-500 data-[state=ok]:bg-emerald-400 data-[state=stale]:bg-amber-400"
              />
              <span ref={rateLabel}>샘플 없음</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            최근 1초 동안 화면에 그려진 프레임 수 (초당)
            <br />
            점 색: 초록 최신 · 노랑 이전 샘플(센서 주기 3배, 최소 0.3초 초과) · 회색 샘플 없음 · 빨강 연결 끊김
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
