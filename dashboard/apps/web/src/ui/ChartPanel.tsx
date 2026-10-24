import { useEffect, useRef } from "react";
import uPlot from "uplot";
import type { SeriesTopic } from "@grandtour/protocol";
import { CHART_COLOR_VARS, themeVar } from "@/lib/theme";
import { live } from "../data/live.ts";
import { estimatePlayhead, useApp } from "../state.ts";
import { Empty, Panel } from "./Panel.tsx";

const REDRAW_MS = 66; // ~15 fps is plenty for a scrolling chart

export function ChartPanel({ slot }: { slot: 0 | 1 }) {
  const chart = useApp((s) => s.ui.charts[slot]);
  const windowSec = useApp((s) => s.ui.chartWindowSec);
  const manifest = useApp((s) => s.manifest);
  const topic = manifest?.topics.find((t) => t.name === chart?.topic && t.kind === "series") as SeriesTopic | undefined;
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!topic || !chart || !el || !manifest) return;
    const colIdx = chart.columns.map((c) => topic.columns.findIndex((x) => x.name === c)).filter((i) => i >= 0);
    const offsets = colIdx.map((i) => topic.columns[i].offset);
    const t0 = manifest.t0;
    const axis = { stroke: themeVar("--muted-foreground"), grid: { stroke: themeVar("--border") }, ticks: { stroke: themeVar("--border") } };
    const colors = CHART_COLOR_VARS.map(themeVar);

    const plot = new uPlot(
      {
        width: el.clientWidth,
        height: Math.max(80, el.clientHeight - 58),
        legend: { show: true, live: false },
        cursor: { show: false },
        scales: { x: { time: false } },
        axes: [
          { ...axis, values: (_u, vals) => vals.map((v) => `${v.toFixed(0)}s`) },
          { ...axis, size: 56 },
        ],
        series: [{}, ...colIdx.map((i, k) => ({ label: topic.columns[i].name, stroke: colors[k % colors.length], width: 1.5 }))],
      },
      [[], ...colIdx.map(() => [])],
      el,
    );

    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < REDRAW_MS) return;
      last = now;
      const t = estimatePlayhead();
      const buf = live.series.get(topic.id);
      const xs: number[] = [];
      const ys: number[][] = colIdx.map(() => []);
      if (buf && buf.length) {
        const end = buf.indexAtOrBefore(t);
        let i = Math.max(0, buf.indexAtOrBefore(t - windowSec) + 1);
        for (; i <= end; i++) {
          xs.push(buf.ts[i] - t0);
          const row = buf.row(i);
          colIdx.forEach((c, k) => ys[k].push(row[c] + offsets[k]));
        }
      }
      plot.setData([xs, ...ys], false);
      plot.setScale("x", { min: t - t0 - windowSec, max: t - t0 });
      plot.redraw(false, true); // rescale y to visible data
    };
    raf = requestAnimationFrame(draw);

    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: Math.max(80, el.clientHeight - 58) }));
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      plot.destroy();
    };
  }, [topic, chart, windowSec, manifest]);

  if (!topic || !chart) {
    return (
      <Panel>
        <Empty>차트를 선택하세요</Empty>
      </Panel>
    );
  }
  return (
    <Panel title={`${topic.name} · 최근 ${windowSec}s`}>
      <div className="chart-host h-full pt-7" ref={host} />
    </Panel>
  );
}
