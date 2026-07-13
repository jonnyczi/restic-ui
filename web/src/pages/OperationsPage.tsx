import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import StatusBadge from "@/components/StatusBadge";
import ProgressBar from "@/components/ops/ProgressBar";
import { useFilteredOperations, useOpLogs, useOpProgress, type OpHistoryFilters } from "@/hooks/useOperations";
import { useRepos } from "@/hooks/useRepos";
import { usePlans } from "@/hooks/usePlans";
import { api } from "@/lib/api";
import { formatWhen, type Operation } from "@/lib/types";

const OP_TYPES = ["backup", "restore", "prune", "check", "copy", "init", "forget", "retention"];
const OP_STATUSES = ["queued", "running", "success", "warning", "error", "canceled"];

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
      {running && <ProgressBar progress={progress} />}

      <div
        ref={scrollRef}
        className="max-h-64 overflow-y-auto break-all rounded bg-black/40 p-2 font-mono text-xs"
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
  const [filters, setFilters] = useState<OpHistoryFilters>({});
  const { data: repos } = useRepos();
  const { data: plans } = usePlans();
  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useFilteredOperations(filters);
  const [open, setOpen] = useState<number | null>(null);

  const operations = data?.pages.flat() ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="text-sm text-muted-foreground">
          History and live progress of backups and maintenance tasks.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Select
          aria-label="Filter by type"
          className="h-8 w-auto text-xs"
          value={filters.type ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value || undefined }))}
        >
          <option value="">All types</option>
          {OP_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by status"
          className="h-8 w-auto text-xs"
          value={filters.status ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value || undefined }))}
        >
          <option value="">All statuses</option>
          {OP_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by plan"
          className="h-8 w-auto text-xs"
          value={filters.planId ?? ""}
          onChange={(e) =>
            setFilters((f) => ({ ...f, planId: e.target.value ? Number(e.target.value) : undefined }))
          }
        >
          <option value="">All plans</option>
          {(plans ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by repository"
          className="h-8 w-auto text-xs"
          value={filters.repoId ?? ""}
          onChange={(e) =>
            setFilters((f) => ({ ...f, repoId: e.target.value ? Number(e.target.value) : undefined }))
          }
        >
          <option value="">All repositories</option>
          {(repos ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        {(filters.type || filters.status || filters.planId || filters.repoId) && (
          <Button size="sm" variant="ghost" onClick={() => setFilters({})}>
            Clear filters
          </Button>
        )}
      </div>

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      )}

      {!isLoading && operations.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="font-medium">Nothing has run yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {Object.keys(filters).length > 0
              ? "No operations match these filters."
              : "Run a backup plan and it will show up here."}
          </p>
        </div>
      )}

      {operations.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                <th className="w-8 p-2"></th>
                <th className="hidden p-2 font-medium md:table-cell">#</th>
                <th className="p-2 font-medium">Type</th>
                <th className="hidden p-2 font-medium md:table-cell">Plan</th>
                <th className="hidden p-2 font-medium md:table-cell">Repository</th>
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
                    <td className="hidden p-2 text-muted-foreground md:table-cell">{op.id}</td>
                    <td className="p-2">{op.type}</td>
                    <td className="hidden p-2 md:table-cell">{op.planName || "—"}</td>
                    <td className="hidden p-2 md:table-cell">{op.repoName || "—"}</td>
                    <td className="p-2">
                      <StatusBadge status={op.status} />
                    </td>
                    <td className="p-2 text-muted-foreground">
                      {op.startedAt ? formatWhen(op.startedAt) : "—"}
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
          {hasNextPage && (
            <div className="border-t p-2 text-center">
              <Button
                size="sm"
                variant="outline"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage && <Loader2 className="animate-spin" />}
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
