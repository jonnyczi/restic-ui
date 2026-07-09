import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { LogLine, Operation, OpProgress, StreamEvent } from "@/lib/types";

export function useOperations(limit = 100) {
  return useQuery({
    queryKey: ["operations"],
    queryFn: () => api.get<Operation[]>(`/api/operations?limit=${limit}`),
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
            if (op.status !== "running" && op.status !== "queued") {
              // Completed: snapshot lists and plan next-runs may have changed.
              qc.invalidateQueries({ queryKey: ["snapshots"] });
              qc.invalidateQueries({ queryKey: ["repo-stats"] });
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
