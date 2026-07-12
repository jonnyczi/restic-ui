import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Camera,
  CheckCircle2,
  Copy,
  Database,
  Eraser,
  Loader2,
  PlugZap,
  Trash2,
  Unlock,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import SnapshotBrowser from "@/components/repos/SnapshotBrowser";
import {
  useDeleteRepo,
  useForgetSnapshot,
  usePruneRepo,
  useRepoAction,
  useRepos,
  useRepoStats,
  useSnapshots,
} from "@/hooks/useRepos";
import { api, ApiError } from "@/lib/api";
import { formatBytes, type Repo } from "@/lib/types";

/** One-line human summary of where a repo points. */
function locationSummary(r: Repo): string {
  const c = r.config;
  switch (r.backendType) {
    case "local":
      return c.path ?? "";
    case "s3":
      return `${c.endpoint}/${c.bucket}${c.prefix ? "/" + c.prefix : ""}`;
    case "sftp":
      return `${c.user}@${c.host}:${c.path}`;
    case "rclone":
      return `${c.remote}:${c.path}`;
  }
}

type Feedback = { kind: "ok" | "err"; text: string } | null;

export default function RepoCard({ repo }: { repo: Repo }) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [browsingSnap, setBrowsingSnap] = useState<string | null>(null);
  const [copyDest, setCopyDest] = useState<number | "">("");

  const action = useRepoAction();
  const del = useDeleteRepo();
  const forget = useForgetSnapshot();
  const prune = usePruneRepo();
  const snapshots = useSnapshots(showSnapshots ? repo.id : null);
  const stats = useRepoStats(showSnapshots ? repo.id : null);
  const { data: allRepos } = useRepos();
  const otherRepos = (allRepos ?? []).filter((r) => r.id !== repo.id);

  const copy = useMutation({
    mutationFn: (destRepoId: number) =>
      api.post(`/api/repos/${repo.id}/copy`, { destRepoId, snapshotIds: [] }),
  });

  async function run(name: "init" | "test" | "check" | "unlock", okText: string) {
    setBusyAction(name);
    setFeedback(null);
    try {
      await action.mutateAsync({ id: repo.id, action: name });
      setFeedback({ kind: "ok", text: okText });
    } catch (err) {
      setFeedback({
        kind: "err",
        text: err instanceof ApiError ? err.message : "Request failed",
      });
    } finally {
      setBusyAction(null);
    }
  }

  const btn = (
    name: "init" | "test" | "check" | "unlock",
    label: string,
    okText: string,
    icon: React.ReactNode,
  ) => (
    <Button
      size="sm"
      variant="outline"
      disabled={busyAction !== null}
      onClick={() => run(name, okText)}
    >
      {busyAction === name ? <Loader2 className="animate-spin" /> : icon}
      {label}
    </Button>
  );

  return (
    <Card data-testid={`repo-${repo.name}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <Database className="size-5 text-primary" />
            <div>
              <div className="font-semibold">{repo.name}</div>
              <div className="text-sm text-muted-foreground">
                <span className="mr-2 rounded bg-secondary px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide">
                  {repo.backendType}
                </span>
                <span className="font-mono text-xs">{locationSummary(repo)}</span>
              </div>
            </div>
          </div>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Remove config? Backup data stays on the backend.
              </span>
              <Button size="sm" variant="destructive" onClick={() => del.mutate(repo.id)}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {btn("test", "Test", "Connection OK — repository reachable and password valid.", <PlugZap />)}
          {btn("init", "Init", "Repository initialized.", <Database />)}
          {btn("check", "Check", "Integrity check passed.", <CheckCircle2 />)}
          {btn("unlock", "Unlock", "Stale locks removed.", <Unlock />)}
          {confirmPrune ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Delete unreferenced data? Long-running; locks the repo.
              </span>
              <Button
                size="sm"
                variant="destructive"
                disabled={prune.isPending}
                onClick={async () => {
                  try {
                    await prune.mutateAsync(repo.id);
                    setFeedback({ kind: "ok", text: "Prune started — see the Operations page." });
                  } catch (err) {
                    setFeedback({
                      kind: "err",
                      text: err instanceof ApiError ? err.message : "Request failed",
                    });
                  } finally {
                    setConfirmPrune(false);
                  }
                }}
              >
                {prune.isPending ? <Loader2 className="animate-spin" /> : null}
                Prune
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmPrune(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirmPrune(true)}>
              <Eraser />
              Prune
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setShowSnapshots((v) => !v)}>
            <Camera />
            Snapshots
          </Button>
        </div>

        {feedback && (
          <p
            role="status"
            className={`flex items-center gap-1.5 text-sm ${
              feedback.kind === "ok" ? "text-green-500" : "text-destructive"
            }`}
          >
            {feedback.kind === "ok" ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            {feedback.text}
          </p>
        )}

        {showSnapshots && (
          <div className="rounded-md border bg-background p-3">
            {stats.data && (
              <p className="mb-2 text-xs text-muted-foreground">
                {stats.data.snapshots_count} snapshot{stats.data.snapshots_count === 1 ? "" : "s"} ·{" "}
                {stats.data.total_file_count} files · {formatBytes(stats.data.total_size)}
              </p>
            )}
            {snapshots.isLoading && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading snapshots…
              </p>
            )}
            {snapshots.isError && (
              <p className="text-sm text-destructive">
                {snapshots.error instanceof ApiError ? snapshots.error.message : "Failed to load snapshots"}
              </p>
            )}
            {snapshots.data && snapshots.data.length === 0 && (
              <p className="text-sm text-muted-foreground">No snapshots yet.</p>
            )}
            {snapshots.data && snapshots.data.length > 0 && (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="pb-1 pr-4 font-medium">ID</th>
                      <th className="pb-1 pr-4 font-medium">Time</th>
                      <th className="pb-1 pr-4 font-medium">Host</th>
                      <th className="pb-1 font-medium">Paths</th>
                      <th className="pb-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshots.data.map((s) => (
                      <tr
                        key={s.id}
                        onClick={() => setBrowsingSnap(browsingSnap === s.id ? null : s.id)}
                        className="cursor-pointer border-t border-border/50 hover:bg-accent/40"
                        title="Click to browse this snapshot"
                      >
                        <td className="py-1.5 pr-4 font-mono text-xs">{s.short_id}</td>
                        <td className="py-1.5 pr-4">{new Date(s.time).toLocaleString()}</td>
                        <td className="py-1.5 pr-4">{s.hostname}</td>
                        <td className="py-1.5 font-mono text-xs">{s.paths.join(", ")}</td>
                        <td className="py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                          {confirmForget === s.id ? (
                            <span className="flex items-center justify-end gap-2 whitespace-nowrap">
                              <span className="text-xs text-muted-foreground">
                                Forget? Data kept until prune.
                              </span>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={forget.isPending}
                                onClick={async () => {
                                  try {
                                    await forget.mutateAsync({ repoId: repo.id, snapshotId: s.id });
                                    setFeedback({
                                      kind: "ok",
                                      text: "Forget started — see the Operations page.",
                                    });
                                  } catch (err) {
                                    setFeedback({
                                      kind: "err",
                                      text: err instanceof ApiError ? err.message : "Request failed",
                                    });
                                  } finally {
                                    setConfirmForget(null);
                                  }
                                }}
                              >
                                {forget.isPending ? <Loader2 className="animate-spin" /> : null}
                                Forget
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setConfirmForget(null)}>
                                Cancel
                              </Button>
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Forget snapshot ${s.short_id}`}
                              onClick={() => setConfirmForget(s.id)}
                            >
                              <Trash2 />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {browsingSnap && (
                  <div className="mt-2">
                    <SnapshotBrowser
                      repoId={repo.id}
                      snapshotId={browsingSnap}
                      onClose={() => setBrowsingSnap(null)}
                    />
                  </div>
                )}
                {otherRepos.length > 0 && (
                  <div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-3">
                    <Copy className="size-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Replicate all snapshots to</span>
                    <Select
                      value={copyDest}
                      onChange={(e) => setCopyDest(Number(e.target.value))}
                      className="h-8 w-auto min-w-40 text-xs"
                      aria-label="Copy destination repository"
                    >
                      <option value="" disabled>
                        Select repository…
                      </option>
                      {otherRepos.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={copyDest === "" || copy.isPending}
                      onClick={async () => {
                        await copy.mutateAsync(copyDest as number);
                        setFeedback({ kind: "ok", text: "Copy started — see the Operations page." });
                      }}
                    >
                      {copy.isPending ? <Loader2 className="animate-spin" /> : <Copy />}
                      Copy
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
