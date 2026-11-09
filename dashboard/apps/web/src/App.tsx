import { useEffect } from "react";
import type { SubscribeTopic } from "@grandtour/protocol";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { send } from "./net/client.ts";
import { CAD_POSE_TOPIC, WORLD_POSE_TOPIC, useApp } from "./state.ts";
import { CameraPanel } from "./ui/CameraPanel.tsx";
import { ChartPanel } from "./ui/ChartPanel.tsx";
import { PlaybackBar } from "./ui/PlaybackBar.tsx";
import { Sidebar } from "./ui/Sidebar.tsx";
import { Viewer3D } from "./ui/Viewer3D.tsx";
import { Panel } from "./ui/Panel.tsx";

/** Subscribe to exactly the topics that some panel is showing. */
function useSubscriptions() {
  const manifest = useApp((s) => s.manifest);
  const ui = useApp((s) => s.ui);
  useEffect(() => {
    if (!manifest) return;
    const names = new Set<string>();
    if (ui.lidar) names.add(ui.lidar);
    if (ui.worldView) names.add(WORLD_POSE_TOPIC);
    if (ui.worldView && ui.showCadPose) names.add(CAD_POSE_TOPIC);
    ui.cameras.forEach((c) => c && names.add(c));
    ui.charts.forEach((c) => c && names.add(c.topic));
    const known = new Set(manifest.topics.map((t) => t.name));
    const topics: SubscribeTopic[] = [...names].filter((n) => known.has(n)).map((name) => ({ name }));
    send({ op: "subscribe", topics });
  }, [manifest, ui.lidar, ui.worldView, ui.showCadPose, ui.cameras, ui.charts]);
}

export function App() {
  const status = useApp((s) => s.status);
  const manifest = useApp((s) => s.manifest);
  useSubscriptions();

  return (
    <TooltipProvider delayDuration={300}>
      <div className="grid h-full grid-cols-[260px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto]">
        <Sidebar />
        {/*
          minmax(0, …) lets tracks shrink below their content (the 3D canvas otherwise pins its column
          when the window narrows). The camera column has a fixed range so images stay legible; the 3D
          view takes the rest. Charts span the full width underneath.
        */}
        <main className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_clamp(320px,26vw,400px)] grid-rows-[minmax(0,1fr)_minmax(0,1fr)_minmax(180px,0.7fr)] gap-2 p-2">
          <div className="row-span-2 min-h-0 min-w-0">
            {manifest ? (
              <Viewer3D />
            ) : (
              <Panel title={`서버 연결 중… (${status})`} className="h-full">
                <Skeleton className="m-3 mt-9 h-[calc(100%-3rem)]" />
              </Panel>
            )}
          </div>
          <CameraPanel slot={0} />
          <CameraPanel slot={1} />
          <div className="col-span-2 grid min-h-0 min-w-0 grid-cols-2 gap-2">
            <ChartPanel slot={0} />
            <ChartPanel slot={1} />
          </div>
        </main>
        <PlaybackBar />
      </div>
      <Toaster theme="dark" position="top-right" richColors />
    </TooltipProvider>
  );
}
