import { useEffect } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { pushToast } from "@/lib/toastStore";
import { formatBytes, type LogLine, type Operation, type OpProgress, type StreamEvent } from "@/lib/types";

const TERMINAL: ReadonlySet<Operation["status"]> = new Set([
  "success",
  "warning",
  "error",
  "canceled",
]);

const STATUS_VERBS: Record<string, string> = {
  success: "succeeded",
  warning: "finished with warnings",
  error: "failed",
};

/**
 * Toast an operation that just reached a terminal state. Skips `canceled`
 * (user-initiated, already has feedback) and repeats of already-terminal
 * statuses. Deliberately ignores the plan's notifyMuted flag — that gates
 * external Apprise pushes; in-app toasts are ambient UI like the Operations
 * page itself.
 */
function maybeToast(op: Operation, seen: Map<number, Operation["status"]>) {
  const prev = seen.get(op.id);
  seen.set(op.id, op.status);
  if (!TERMINAL.has(op.status) || (prev !== undefined && TERMINAL.has(prev))) return;
  if (op.status === "canceled") return;

  const subject = op.planName || op.repoName;
  const title = `${op.type[0].toUpperCase()}${op.type.slice(1)}${subject ? ` "${subject}"` : ""} ${STATUS_VERBS[op.status]}`;
  let message: string | undefined;
  if (op.status !== "error" && op.summary?.data_added !== undefined) {
    message = `${formatBytes(op.summary.data_added)} added`;
  }
  pushToast({
    kind: op.status === "success" ? "success" : op.status === "warning" ? "warning" : "error",
    title,
    message,
  });
}

export function useOperations(limit = 100) {
  return useQuery({
    queryKey: ["operations"],
    queryFn: () => api.get<Operation[]>(`/api/operations?limit=${limit}`),
  });
}

export interface OpHistoryFilters {
  type?: string;
  status?: string;
  repoId?: number;
  planId?: number;
}

const PAGE_SIZE = 50;

/**
 * Filtered + "load more" operation history for the Operations page. Kept as
 * a separate query key from `useOperations()` so this page's filtering and
 * cursor pagination can't disturb the live WebSocket-fed cache that the
 * Dashboard and PlanCard rely on for real-time status.
 */
export function useFilteredOperations(filters: OpHistoryFilters) {
  return useInfiniteQuery({
    queryKey: ["operations", "filtered", filters],
    queryFn: ({ pageParam }: { pageParam: number | undefined }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (filters.type) params.set("type", filters.type);
      if (filters.status) params.set("status", filters.status);
      if (filters.repoId) params.set("repoId", String(filters.repoId));
      if (filters.planId) params.set("planId", String(filters.planId));
      if (pageParam) params.set("beforeId", String(pageParam));
      return api.get<Operation[]>(`/api/operations?${params}`);
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length < PAGE_SIZE ? undefined : lastPage[lastPage.length - 1].id,
  });
}

export function useOpLogs(opId: number | null) {
  return useQuery({
    queryKey: ["op-logs", opId],
    queryFn: () => api.get<LogLine[]>(`/api/operations/${opId}/logs`),
    enabled: opId !== null,
  });
}

/** Live progress for one operation, fed by the WebSocket stream. */
export function useOpProgress(opId: number) {
  return useQuery<OpProgress | null>({
    queryKey: ["op-progress", opId],
    queryFn: () => null, // populated only by stream events
    staleTime: Infinity,
    initialData: null,
  });
}

/**
 * Opens the app-wide event stream and folds events into the query cache:
 * - "op": upsert into the operations list (and refresh plans on completion)
 * - "log": append to that op's log query, if loaded
 * - "progress": update the op's live progress query
 * Reconnects with backoff while the tab stays open.
 */
export function useEventStream(enabled: boolean) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    // Last status seen per op id, for toast dedupe. The ["operations"] cache
    // can't serve this role — it's only populated once the Plans page has
    // mounted. The hub never replays history on reconnect, so a first-seen
    // terminal status is always a genuine live completion.
    const seen = new Map<number, Operation["status"]>();

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/stream`);

      ws.onopen = () => {
        retry = 0;
      };
      ws.onmessage = (e) => {
        let ev: StreamEvent;
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        switch (ev.type) {
          case "op": {
            const op = ev.op!;
            maybeToast(op, seen);
            qc.setQueryData<Operation[]>(["operations"], (old) => {
              if (!old) return old;
              const i = old.findIndex((o) => o.id === op.id);
              if (i >= 0) {
                const next = old.slice();
                next[i] = op;
                return next;
              }
              return [op, ...old];
            });
            // Patch the same operation wherever it's already loaded in the
            // Operations page's filtered/paginated cache. A row this event
            // doesn't match anywhere is either filtered out or brand new
            // (e.g. a scheduled run created with no user navigation to
            // trigger a refetch) — either way, refetch so it shows up if it
            // belongs.
            let matchedAnywhere = false;
            qc.setQueriesData<InfiniteData<Operation[], number | undefined>>(
              { queryKey: ["operations", "filtered"] },
              (old) => {
                if (!old) return old;
                let changed = false;
                const pages = old.pages.map((page) => {
                  const i = page.findIndex((o) => o.id === op.id);
                  if (i < 0) return page;
                  changed = true;
                  matchedAnywhere = true;
                  const next = page.slice();
                  next[i] = op;
                  return next;
                });
                return changed ? { ...old, pages } : old;
              },
            );
            if (!matchedAnywhere) {
              qc.invalidateQueries({ queryKey: ["operations", "filtered"] });
            }
            if (op.status !== "running" && op.status !== "queued") {
              // Completed: snapshot lists and plan next-runs may have changed.
              qc.invalidateQueries({ queryKey: ["snapshots"] });
              qc.invalidateQueries({ queryKey: ["repo-stats"] });
              qc.invalidateQueries({ queryKey: ["repo-stats-history"] });
              qc.invalidateQueries({ queryKey: ["plans"] });
            }
            break;
          }
          case "log": {
            qc.setQueryData<LogLine[]>(["op-logs", ev.opId], (old) =>
              old ? [...old, ev.log!] : old,
            );
            break;
          }
          case "progress": {
            qc.setQueryData(["op-progress", ev.opId], ev.progress);
            break;
          }
        }
      };
      ws.onclose = () => {
        if (closed) return;
        retry++;
        setTimeout(connect, Math.min(1000 * 2 ** retry, 15000));
      };
    };

    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [enabled, qc]);
}
