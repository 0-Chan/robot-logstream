import { useState, type ReactNode } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import type { SeriesTopic, TopicKind, TopicMeta } from "@grandtour/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { CAD_POSE_TOPIC, useApp, type ChartConfig, type MapMode } from "../state.ts";

const NONE = "__none__"; // Radix Select does not allow an empty-string item value
const MAX_COLUMNS = 8;
// Anchor option lists to the trigger. The default "item-aligned" mode shifts the list so the selected
// item sits over the trigger, which makes the popup jump around depending on the current value.
const POPPER = { position: "popper", side: "bottom", align: "start", sideOffset: 4 } as const;

/** Quick picks for the chart panels; any series topic/column can also be chosen manually. */
const CHART_PRESETS: { label: string; chart: ChartConfig }[] = [
  { label: "관절 각도 (LF)", chart: { topic: "anymal_state_state_estimator", columns: ["joint_positions.LF_HAA", "joint_positions.LF_HFE", "joint_positions.LF_KFE"] } },
  { label: "무릎 각도 (4다리)", chart: { topic: "anymal_state_state_estimator", columns: ["joint_positions.LF_KFE", "joint_positions.RF_KFE", "joint_positions.LH_KFE", "joint_positions.RH_KFE"] } },
  { label: "발 접촉 상태", chart: { topic: "anymal_state_state_estimator", columns: ["LF_FOOT_state", "RF_FOOT_state", "LH_FOOT_state", "RH_FOOT_state"] } },
  { label: "발 접촉력 z", chart: { topic: "anymal_state_state_estimator", columns: ["LF_FOOT_wrench_force.z", "RF_FOOT_wrench_force.z", "LH_FOOT_wrench_force.z", "RH_FOOT_wrench_force.z"] } },
  { label: "몸체 속도", chart: { topic: "anymal_state_state_estimator", columns: ["twist_lin.x", "twist_lin.y", "twist_ang.z"] } },
  { label: "STIM320 각속도", chart: { topic: "stim320_imu", columns: ["ang_vel.x", "ang_vel.y", "ang_vel.z"] } },
  { label: "STIM320 가속도", chart: { topic: "stim320_imu", columns: ["lin_acc.x", "lin_acc.y", "lin_acc.z"] } },
  { label: "조종 명령", chart: { topic: "anymal_command_twist", columns: ["linear.x", "linear.y", "angular.z"] } },
  { label: "배터리", chart: { topic: "anymal_state_battery", columns: ["voltage", "current", "state_of_charge"] } },
  { label: "CAD 위치 추정 오차 (m)", chart: { topic: CAD_POSE_TOPIC, columns: ["err_pos", "odom_err_pos"] } },
  { label: "CAD 정합 품질", chart: { topic: CAD_POSE_TOPIC, columns: ["fitness", "rmse", "constrainedDims"] } },
];

const MAP_MODES: { value: MapMode; label: string }[] = [
  { value: "points", label: "점군 지도 (DLIO)" },
  { value: "cad", label: "간이 CAD" },
  { value: "both", label: "겹쳐 보기" },
  { value: "none", label: "없음" },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function TopicSelect({
  value,
  topics,
  onChange,
  placeholder = "(없음)",
}: {
  value: string | null;
  topics: TopicMeta[];
  onChange: (v: string | null) => void;
  placeholder?: string;
}) {
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger size="sm" className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent {...POPPER} className="max-h-72">
        <SelectItem value={NONE}>{placeholder}</SelectItem>
        {topics.map((t) => (
          <SelectItem key={t.name} value={t.name}>
            {t.name}
            {t.kind === "depth" && <span className="text-muted-foreground">· depth</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ToggleRow({ id, label, checked, disabled, onChange }: { id: string; label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor={id} className={disabled ? "opacity-50" : undefined}>
        {label}
      </Label>
      <Switch id={id} size="sm" checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/** Searchable multi-select for series columns (some topics have 70+). */
function ColumnPicker({ topic, selected, onChange }: { topic: SeriesTopic; selected: string[]; onChange: (cols: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const full = selected.length >= MAX_COLUMNS;
  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((c) => c !== name) : full ? selected : [...selected, name]);

  return (
    <div className="flex flex-col gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
            열 {selected.length}/{MAX_COLUMNS}개 선택
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="열 이름 검색…" />
            <CommandList>
              <CommandEmpty>일치하는 열이 없습니다.</CommandEmpty>
              <CommandGroup heading={`${topic.name} · ${topic.columns.length}열`}>
                {topic.columns.map((c) => {
                  const checked = selected.includes(c.name);
                  return (
                    <CommandItem key={c.name} value={c.name} disabled={!checked && full} onSelect={() => toggle(c.name)}>
                      <Checkbox checked={checked} className="pointer-events-none" />
                      <span className="truncate">{c.name}</span>
                      {checked && <Check className="ml-auto opacity-60" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((c) => (
            <Badge key={c} variant="secondary" className="max-w-full cursor-pointer truncate font-normal" onClick={() => toggle(c)} title="클릭해서 제거">
              {c} ×
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/** Project name and mark; stays put while the settings below scroll. Same height as the playback bar. */
function Brand() {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
      <img src="/logo.png" alt="" className="size-7 shrink-0 rounded-md" />
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-sm font-semibold">Robot Logstream</span>
        <span className="truncate text-xs text-muted-foreground">보행 로봇 센서 기록 분석</span>
      </div>
    </div>
  );
}

export function Sidebar() {
  const manifest = useApp((s) => s.manifest);
  const ui = useApp((s) => s.ui);
  const setUi = useApp((s) => s.setUi);
  if (!manifest)
    return (
      <aside className="flex min-h-0 min-w-0 flex-col border-r bg-card">
        <Brand />
      </aside>
    );

  const byKind = (...kinds: TopicKind[]) => manifest.topics.filter((t) => kinds.includes(t.kind));
  const seriesTopics = byKind("series") as SeriesTopic[];
  const hasCadPose = manifest.topics.some((t) => t.name === CAD_POSE_TOPIC);

  const setCamera = (slot: 0 | 1, v: string | null) => {
    const cameras = [...ui.cameras] as typeof ui.cameras;
    cameras[slot] = v;
    setUi({ cameras });
  };
  const setChart = (slot: 0 | 1, chart: ChartConfig | null) => {
    const charts = [...ui.charts] as typeof ui.charts;
    charts[slot] = chart;
    setUi({ charts });
  };

  return (
    <aside className="flex min-h-0 min-w-0 flex-col border-r bg-card">
      <Brand />
      {/* Radix wraps content in a display:table div that grows with content; force block so it fits the sidebar */}
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="flex flex-col gap-5 p-4">
          <Section title="3D 뷰">
            <Field label="LiDAR">
              <TopicSelect value={ui.lidar} topics={byKind("pointcloud")} onChange={(v) => setUi({ lidar: v })} />
            </Field>
            <ToggleRow id="world" label="맵 좌표계 (DLIO 포즈)" checked={ui.worldView} onChange={(v) => setUi({ worldView: v })} />
            <Field label="지도">
              <Select value={ui.mapMode} onValueChange={(v) => setUi({ mapMode: v as MapMode })} disabled={!ui.worldView}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent {...POPPER}>
                  {MAP_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value} disabled={m.value !== "points" && m.value !== "none" && !manifest.static.cad}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <ToggleRow
              id="cad-pose"
              label="CAD 위치 추정 마커"
              checked={ui.showCadPose}
              disabled={!ui.worldView || !hasCadPose}
              onChange={(v) => setUi({ showCadPose: v })}
            />
          </Section>

          <Separator />

          <Section title="카메라">
            {([0, 1] as const).map((slot) => (
              <Field key={slot} label={`슬롯 ${slot + 1}`}>
                <TopicSelect value={ui.cameras[slot]} topics={byKind("image", "depth")} onChange={(v) => setCamera(slot, v)} />
              </Field>
            ))}
          </Section>

          {([0, 1] as const).map((slot) => {
            const chart = ui.charts[slot];
            const topic = seriesTopics.find((t) => t.name === chart?.topic);
            return (
              <div key={slot} className="flex flex-col gap-5">
                <Separator />
                <Section title={`차트 ${slot + 1}`}>
                  <Field label="프리셋">
                    <Select
                      value=""
                      onValueChange={(v) => {
                        const p = CHART_PRESETS[Number(v)];
                        if (p) setChart(slot, p.chart);
                      }}
                    >
                      <SelectTrigger size="sm" className="w-full">
                        <SelectValue placeholder="프리셋 선택…" />
                      </SelectTrigger>
                      <SelectContent {...POPPER} className="max-h-72">
                        {CHART_PRESETS.map((p, i) => (
                          <SelectItem key={p.label} value={String(i)} disabled={!manifest.topics.some((t) => t.name === p.chart.topic)}>
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="토픽">
                    <TopicSelect
                      value={chart?.topic ?? null}
                      topics={seriesTopics}
                      onChange={(v) => {
                        const t = seriesTopics.find((x) => x.name === v);
                        setChart(slot, t ? { topic: t.name, columns: t.columns.slice(0, 3).map((c) => c.name) } : null);
                      }}
                    />
                  </Field>
                  {topic && chart && (
                    <ColumnPicker topic={topic} selected={chart.columns} onChange={(columns) => setChart(slot, { topic: topic.name, columns })} />
                  )}
                </Section>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </aside>
  );
}
