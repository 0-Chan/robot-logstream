import type { ReactNode, Ref } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Card with a thin title overlay, so 3D / camera / chart content can use the full card area. */
export function Panel({
  title,
  right,
  className,
  children,
}: {
  title?: ReactNode;
  right?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("relative min-h-0 min-w-0 gap-0 overflow-hidden rounded-lg p-0 py-0", className)}>
      {title !== undefined && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-card via-card/80 to-transparent px-3 py-1.5 text-xs text-muted-foreground">
          <span className="truncate">{title}</span>
          {right && <span className="ml-auto flex items-center gap-1">{right}</span>}
        </div>
      )}
      {children}
    </Card>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="grid h-full place-items-center text-sm text-muted-foreground">{children}</div>;
}

/**
 * Centered status note over panel content ("no data at this time", "transform missing", …).
 * Hidden when empty, so render loops can set `textContent` on the ref without React re-renders.
 */
export function Notice({ ref, children }: { ref?: Ref<HTMLDivElement>; children?: ReactNode }) {
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-md bg-background/80 px-3 py-1.5 text-xs text-muted-foreground empty:hidden"
    >
      {children}
    </div>
  );
}
