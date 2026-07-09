import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import StatusBadge from "@/components/StatusBadge";
import { useOperations, useOpLogs, useOpProgress } from "@/hooks/useOperations";
import { api } from "@/lib/api";
import { formatBytes, type Operation } from "@/lib/types";

function duration(op: Operation): string {
  if (!op.startedAt) return "—";
  const end = op.endedAt ? new Date(op.endedAt) : new Date();
  const secs = Math.max(0, (end.getTime() - new Date(op.startedAt).getTime()) / 1000);
  if (secs < 60) return `${Math.round(secs)}s`;
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
}

const LEVEL_STYLES: Record<string, string> = {
  info: "text-foreground/90",
  warn: "text-amber-500",
  error: "text-destructive",
};

/** Progress bar + log console for one operation. */
function OpDetail({ op }: { op: Operation }) {
  const { data: logs } = useOpLogs(op.id);
  const { data: progress } = useOpProgress(op.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const running = op.status === "running" || op.status === "queued";

  const cancel = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`/api/operations/${op.id}/cancel`),
  });

  // Follow the log tail while running.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [logs?.length, running]);

  return (
    <div className="space-y-2 border-t bg-background/50 p-3">
      {running && progress && (
        <div className="space-y-1" data-testid="op-progress">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              {progress.filesDone}/{progress.totalFiles} files ·{" "}
              {formatBytes(progress.bytesDone)}/{formatBytes(progress.totalBytes)}
              {progress.currentFile && <> · {progress.currentFile}</>}
            </span>
            <span>{Math.round(progress.percentDone * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-secondary">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.round(progress.percentDone * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className="max-h-64 overflow-y-auto rounded bg-black/40 p-2 font-mono text-xs"
        data-testid="op-logs"
      >
        {!logs && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Loading logs…
          </p>
        )}
        {logs?.length === 0 && <p className="text-muted-foreground">No log output.</p>}
        {logs?.map((l) => (
          <div key={l.seq} className={LEVEL_STYLES[l.level] ?? ""}>
            <span className="mr-2 text-muted-foreground">
              {new Date(l.ts).toLocaleTimeString()}
            </span>
            {l.message}
          </div>
        ))}
      </div>

      {running && (
        <Button size="sm" variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          <Square />
          Cancel
        </Button>
      )}
    </div>
  );
}

export default function OperationsPage() {
  const { data: operations, isLoading } = useOperations();
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="text-sm text-muted-foreground">
          History and live progress of backups and maintenance tasks.
        </p>
      </div>

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      )}

      {operations && operations.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="font-medium">Nothing has run yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Run a backup plan and it will show up here.
          </p>
        </div>
      )}

      {operations && operations.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                <th className="w-8 p-2"></th>
                <th className="p-2 font-medium">#</th>
                <th className="p-2 font-medium">Type</th>
                <th className="p-2 font-medium">Plan</th>
                <th className="p-2 font-medium">Repository</th>
                <th className="p-2 font-medium">Status</th>
                <th className="p-2 font-medium">Started</th>
                <th className="p-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op) => (
                <>
                  <tr
                    key={op.id}
                    data-testid={`op-row-${op.id}`}
                    onClick={() => setOpen(open === op.id ? null : op.id)}
                    className="cursor-pointer border-b border-border/50 last:border-0 hover:bg-accent/40"
                  >
                    <td className="p-2 text-muted-foreground">
                      {open === op.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </td>
                    <td className="p-2 text-muted-foreground">{op.id}</td>
                    <td className="p-2">{op.type}</td>
                    <td className="p-2">{op.planName || "—"}</td>
                    <td className="p-2">{op.repoName || "—"}</td>
                    <td className="p-2">
                      <StatusBadge status={op.status} />
                    </td>
                    <td className="p-2 text-muted-foreground">
                      {op.startedAt ? new Date(op.startedAt).toLocaleString() : "—"}
                    </td>
                    <td className="p-2 text-muted-foreground">{duration(op)}</td>
                  </tr>
                  {open === op.id && (
                    <tr key={`detail-${op.id}`}>
                      <td colSpan={8} className="p-0">
                        <OpDetail op={op} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
