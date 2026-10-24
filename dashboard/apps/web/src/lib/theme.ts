// Read shadcn theme tokens (CSS variables, often oklch) for non-CSS consumers: three.js and uPlot.

/** Raw CSS value of a theme variable, e.g. themeVar("--chart-1") -> "oklch(0.7 0.15 255)". */
export function themeVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Resolve any CSS color (incl. oklch) to "#rrggbb" via a 1x1 canvas, for libraries like three.js. */
export function themeVarHex(name: string): string {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.fillStyle = themeVar(name) || "#000";
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export const CHART_COLOR_VARS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7", "--chart-8"];
