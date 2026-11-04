// User-facing wording for sample selection states, shared by all panels.
import type { Selection } from "../data/select.ts";

export interface StatusContext {
  /** Playhead is before the topic's first sample. */
  beforeStart: boolean;
  /** A seek happened moments ago and the new position's data is still arriving. */
  moving: boolean;
  /** What this panel shows, e.g. "프레임", "점군". */
  noun: string;
}

const secs = (age: number) => (age < 1 ? `${Math.round(age * 1000)} ms` : `${age.toFixed(1)} s`);

/** Centered notice for the panel ("" = nothing to say, data is shown normally). */
export function noticeText(sel: Selection, ctx: StatusContext): string {
  switch (sel.state) {
    case "ok":
    case "stale":
      return "";
    case "disconnected":
      return "연결 끊김 · 재생 시각을 멈추고 마지막으로 받은 화면을 표시 중";
    case "future":
      return "이동 중…";
    case "none":
      if (ctx.beforeStart) return `해당 시점 ${ctx.noun} 없음 (첫 샘플 이전)`;
      if (Number.isNaN(sel.age)) return ctx.moving ? "이동 중…" : `해당 시점 ${ctx.noun} 없음`;
      return `해당 시점 ${ctx.noun} 없음 (마지막 샘플 ${secs(sel.age)} 전)`;
  }
}

/** Short label for the sample-age badge. */
export function ageText(sel: Selection): string {
  if (Number.isNaN(sel.age) || sel.state === "none" || sel.state === "future") return "샘플 없음";
  if (sel.state === "stale") return `이전 샘플 ${secs(sel.age)} 전`;
  return `샘플 경과 ${secs(Math.max(0, sel.age))}`;
}
