import { cn } from "@/lib/utils";

/** Project mark: a four-legged robot over a signal trace (the recorded log). Same drawing as public/favicon.svg. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className={cn("size-7 text-chart-1", className)}>
      <rect x="1" y="1" width="30" height="30" rx="7" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeOpacity="0.5" />
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="7" y="8.5" width="15" height="5" rx="1.5" />
        <rect x="22" y="9" width="3.5" height="3" rx="1" />
        <path d="M9 13.5l-1.5 3 1.5 3M12 13.5l-1.5 3 1.5 3M17 13.5l1.5 3-1.5 3M20 13.5l1.5 3-1.5 3" />
        <path d="M4 25h5l2-3 2.5 5 2-3.5 1.5 1.5h11" strokeOpacity="0.75" />
      </g>
    </svg>
  );
}
