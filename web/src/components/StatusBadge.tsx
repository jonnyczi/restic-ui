import { cn } from "@/lib/utils";
import type { OpStatus } from "@/lib/types";

const STYLES: Record<OpStatus, string> = {
  queued: "bg-secondary text-secondary-foreground",
  running: "bg-blue-500/15 text-blue-500",
  success: "bg-green-500/15 text-green-500",
  warning: "bg-amber-500/15 text-amber-500",
  error: "bg-destructive/15 text-destructive",
  canceled: "bg-secondary text-muted-foreground",
};

export default function StatusBadge({ status }: { status: OpStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide",
        STYLES[status],
      )}
    >
      {status}
    </span>
  );
}
