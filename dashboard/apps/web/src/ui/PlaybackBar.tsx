import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { pause, play, seek, setSpeed } from "../net/client.ts";
import { estimatePlayhead, useApp } from "../state.ts";

const SPEEDS = [0.25, 0.5, 1, 2, 4];
/** While dragging the timeline, send at most this many seeks per second (each one is a new epoch). */
const DRAG_SEEK_INTERVAL_MS = 100;
const STATUS_LABEL = { connecting: "연결 중", open: "연결됨", closed: "끊김" } as const;

function StatusDot({ status }: { status: keyof typeof STATUS_LABEL }) {
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full",
        status === "open" ? "bg-emerald-500" : status === "closed" ? "bg-destructive" : "bg-amber-500",
      )}
    />
  );
}

/** Playback controls, pinned to the bottom of the window. */
export function PlaybackBar() {
  const manifest = useApp((s) => s.manifest);
  const clock = useApp((s) => s.clock);
  const status = useApp((s) => s.status);
  const stats = useApp((s) => s.stats);
  const [scrub, setScrub] = useState<number | null>(null);
  const lastDragSeek = useRef(0);
  const live = !!manifest && status === "open";
  const [display, setDisplay] = useState(0);

  // smooth playhead between 10 Hz clock messages
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setDisplay(estimatePlayhead());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const t0 = manifest?.t0 ?? 0;
  const dur = manifest ? manifest.t1 - t0 : 0;
  const rel = (scrub ?? display) - t0;

  return (
    <footer className="col-span-2 flex h-14 items-center gap-3 border-t bg-card px-4">
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-sm font-semibold">GrandTour Playback</span>
        <span className="truncate text-xs text-muted-foreground">{manifest?.sequence ?? "—"}</span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary">기록 재생</Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          녹화된 기록을 서버가 재생해 보내는 중입니다. 실제 로봇과의 실시간 연결이 아닙니다.
        </TooltipContent>
      </Tooltip>
      <Separator orientation="vertical" className="h-8" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            disabled={!live}
            aria-label={clock.playing ? "일시정지" : "재생"}
            onClick={() => (clock.playing ? pause() : play())}
          >
            {clock.playing ? <Pause /> : <Play />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{clock.playing ? "일시정지" : "재생"}</TooltipContent>
      </Tooltip>

      <Select value={String(clock.speed)} onValueChange={(v) => setSpeed(Number(v))} disabled={!live}>
        <SelectTrigger size="sm" className="w-20" aria-label="재생 속도">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" side="top" align="start" sideOffset={6}>
          {SPEEDS.map((s) => (
            <SelectItem key={s} value={String(s)}>
              ×{s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Slider
        className="flex-1"
        min={0}
        max={Math.max(dur, 0.01)}
        step={0.05}
        value={[Math.min(Math.max(rel, 0), dur)]}
        disabled={!live}
        aria-label="타임라인"
        onValueChange={([v]) => {
          setScrub(t0 + v);
          const now = performance.now();
          if (now - lastDragSeek.current >= DRAG_SEEK_INTERVAL_MS) {
            lastDragSeek.current = now;
            seek(t0 + v);
          }
        }}
        onValueCommit={([v]) => {
          seek(t0 + v); // always land exactly where the user let go
          // Radix calls onValueCommit BEFORE onValueChange for keyboard input; clearing in the same tick
          // would be undone and leave the display stuck at the scrub value.
          setTimeout(() => setScrub(null), 0);
        }}
      />

      <span className="w-28 text-right text-xs tabular-nums text-muted-foreground">
        {rel.toFixed(1)} / {dur.toFixed(1)} s
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1.5 tabular-nums">
            <StatusDot status={status} />
            {status === "open"
              ? `${STATUS_LABEL.open} · ${stats.mbPerSec.toFixed(2)} MB/s · 수신 프레임 ${stats.framesPerSec}/s`
              : STATUS_LABEL[status]}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          재생 서버와의 WebSocket 연결 상태입니다. MB/s는 초당 수신 데이터량, 수신 프레임은 초당 받은 점군·영상 프레임
          수(구독한 모든 카메라·LiDAR 합계)이며 화면 렌더링 FPS가 아닙니다.
        </TooltipContent>
      </Tooltip>
    </footer>
  );
}
