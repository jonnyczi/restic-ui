import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  CalendarClock,
  Camera,
  CheckCircle2,
  Copy,
  Database,
  Eraser,
  Loader2,
  PlugZap,
  Search,
  Trash2,
  Unlock,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import SnapshotBrowser from "@/components/repos/SnapshotBrowser";
import Sparkline from "@/components/Sparkline";
import {
  useCheckRepo,
  useDeleteRepo,
  useForgetSnapshot,
  usePruneRepo,
  useRepoAction,
  useRepos,
  useRepoStats,
  useRepoStatsHistory,
  useSetCheckSchedule,
  useSnapshots,
} from "@/hooks/useRepos";
import { api, ApiError } from "@/lib/api";
import { humanizeCron, SCHEDULE_PRESETS } from "@/lib/cronHumanize";
import { formatBytes, formatWhen, type DiffResult, type FindResult, type Repo } from "@/lib/types";

const CHECK_PRESETS = SCHEDULE_PRESETS.map((p) =>
  p.value === "" ? { ...p, label: "No automatic checks" } : p,
);

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
  const [checkPreset, setCheckPreset] = useState(() =>
    SCHEDULE_PRESETS.some((p) => p.value === repo.checkScheduleCron)
      ? repo.checkScheduleCron
      : "custom",
  );
  const [checkCronDraft, setCheckCronDraft] = useState(repo.checkScheduleCron);
  const [findPattern, setFindPattern] = useState("");
  const [diffFrom, setDiffFrom] = useState("");
  const [diffTo, setDiffTo] = useState("");

  const action = useRepoAction();
  const del = useDeleteRepo();
  const forget = useForgetSnapshot();
  const prune = usePruneRepo();
  const check = useCheckRepo();
  const setSchedule = useSetCheckSchedule();
  const snapshots = useSnapshots(showSnapshots ? repo.id : null);
  const stats = useRepoStats(showSnapshots ? repo.id : null);
  const history = useRepoStatsHistory(showSnapshots ? repo.id : null);
  const { data: allRepos } = useRepos();
  const otherRepos = (allRepos ?? []).filter((r) => r.id !== repo.id);

  const copy = useMutation({
    mutationFn: (destRepoId: number) =>
      api.post(`/api/repos/${repo.id}/copy`, { destRepoId, snapshotIds: [] }),
  });
  const find = useMutation({
    mutationFn: (pattern: string) =>
      api.get<FindResult[]>(`/api/repos/${repo.id}/find?pattern=${encodeURIComponent(pattern)}`),
  });
  const diff = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      api.get<DiffResult>(`/api/repos/${repo.id}/diff?from=${from}&to=${to}`),
  });

  // Compare defaults to the two most recent snapshots (list is newest-first).
  const diffFromVal = diffFrom || snapshots.data?.[1]?.id || "";
  const diffToVal = diffTo || snapshots.data?.[0]?.id || "";

  async function saveCheckSchedule(cron: string) {
    setFeedback(null);
    try {
      await setSchedule.mutateAsync({ repoId: repo.id, cron });
      setFeedback({
        kind: "ok",
        text: cron === "" ? "Automatic checks disabled." : `Auto-check saved: ${humanizeCron(cron)}.`,
      });
    } catch (err) {
      setFeedback({
        kind: "err",
        text: err instanceof ApiError ? err.message : "Request failed",
      });
    }
  }

  async function run(name: "init" | "test" | "unlock", okText: string) {
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
    name: "init" | "test" | "unlock",
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
                <span className="break-all font-mono text-xs">{locationSummary(repo)}</span>
              </div>
            </div>
          </div>
          {confirmDelete ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
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
          <Button
            size="sm"
            variant="outline"
            disabled={check.isPending}
            onClick={async () => {
              setFeedback(null);
              try {
                await check.mutateAsync(repo.id);
                setFeedback({ kind: "ok", text: "Check started — see the Operations page." });
              } catch (err) {
                setFeedback({
                  kind: "err",
                  text: err instanceof ApiError ? err.message : "Request failed",
                });
              }
            }}
          >
            {check.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
            Check
          </Button>
          {btn("unlock", "Unlock", "Stale locks removed.", <Unlock />)}
          {confirmPrune ? (
            <div className="flex flex-wrap items-center gap-2">
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

        <p className="text-xs text-muted-foreground">
          <b className="font-medium text-foreground">Unlock</b> clears a stale lock left behind by
          a crashed process — safe to run unless another operation on this repo is genuinely in
          progress. <b className="font-medium text-foreground">Prune</b> reclaims space after
          forgotten snapshots; it rewrites pack files, so it's long-running and best scheduled off-peak.
        </p>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <CalendarClock className="size-4" />
          <span>Auto-check:</span>
          <Select
            value={checkPreset}
            aria-label="Integrity check schedule"
            className="h-8 w-auto text-xs"
            onChange={(e) => {
              const v = e.target.value;
              setCheckPreset(v);
              if (v !== "custom") void saveCheckSchedule(v);
            }}
          >
            {CHECK_PRESETS.map((p) => (
              <option key={p.label} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
          {checkPreset === "custom" && (
            <>
              <Input
                value={checkCronDraft}
                onChange={(e) => setCheckCronDraft(e.target.value)}
                placeholder="0 5 * * 0"
                aria-label="Custom check cron"
                className="h-8 w-auto min-w-32 font-mono text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={setSchedule.isPending || !checkCronDraft.trim()}
                onClick={() => void saveCheckSchedule(checkCronDraft.trim())}
              >
                {setSchedule.isPending && <Loader2 className="animate-spin" />}
                Save
              </Button>
            </>
          )}
          {repo.nextCheck && <span>(next: {formatWhen(repo.nextCheck)})</span>}
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
              <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <p className="text-xs text-muted-foreground">
                  {stats.data.snapshots_count} snapshot{stats.data.snapshots_count === 1 ? "" : "s"} ·{" "}
                  {stats.data.total_file_count} files · {formatBytes(stats.data.total_size)}
                </p>
                {(history.data?.length ?? 0) >= 2 && (
                  <div className="w-28" data-testid="repo-size-trend">
                    <Sparkline
                      points={history.data!.map((p) => p.totalSize)}
                      height={20}
                      ariaLabel={`${repo.name} size over ${history.data!.length} measurements`}
                    />
                  </div>
                )}
              </div>
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
                <form
                  className="mb-2 flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (findPattern.trim()) find.mutate(findPattern.trim());
                  }}
                >
                  <Input
                    value={findPattern}
                    onChange={(e) => setFindPattern(e.target.value)}
                    placeholder="Find a file across snapshots (e.g. *.pdf or notes.md)"
                    aria-label="Find file pattern"
                    className="h-8 w-auto min-w-48 flex-1 text-xs"
                  />
                  <Button size="sm" variant="outline" type="submit" disabled={find.isPending || !findPattern.trim()}>
                    {find.isPending ? <Loader2 className="animate-spin" /> : <Search />}
                    Find
                  </Button>
                </form>
                {find.isError && (
                  <p className="mb-2 text-xs text-destructive">
                    {find.error instanceof ApiError ? find.error.message : "Search failed"}
                  </p>
                )}
                {find.data && (
                  <div className="mb-2 rounded-md border p-2 text-xs" data-testid="find-results">
                    {find.data.length === 0 && <p className="text-muted-foreground">No matches.</p>}
                    {find.data.map((g) => (
                      <div key={g.snapshot} className="py-1 first:pt-0 last:pb-0">
                        <button
                          type="button"
                          className="font-mono text-xs hover:underline"
                          onClick={() => setBrowsingSnap(g.snapshot)}
                          title="Browse this snapshot"
                        >
                          {g.snapshot.slice(0, 8)}
                        </button>
                        <span className="ml-2 text-muted-foreground">
                          {g.hits} hit{g.hits === 1 ? "" : "s"}
                        </span>
                        <ul className="mt-0.5 space-y-0.5 font-mono text-muted-foreground">
                          {g.matches.slice(0, 20).map((m) => (
                            <li key={m.path} className="break-all">
                              {m.path}
                            </li>
                          ))}
                          {g.matches.length > 20 && <li>+{g.matches.length - 20} more</li>}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="pb-1 pr-4 font-medium">ID</th>
                        <th className="pb-1 pr-4 font-medium">Time</th>
                        <th className="hidden pb-1 pr-4 font-medium md:table-cell">Host</th>
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
                          <td className="py-1.5 pr-4">{formatWhen(s.time)}</td>
                          <td className="hidden py-1.5 pr-4 md:table-cell">{s.hostname}</td>
                          <td className="py-1.5 font-mono text-xs">{s.paths.join(", ")}</td>
                          <td className="py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                            {confirmForget === s.id ? (
                              <span className="flex flex-wrap items-center justify-end gap-2">
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
                </div>
                {browsingSnap && (
                  <div className="mt-2">
                    <SnapshotBrowser
                      repoId={repo.id}
                      snapshotId={browsingSnap}
                      onClose={() => setBrowsingSnap(null)}
                    />
                  </div>
                )}
                {snapshots.data.length >= 2 && (
                  <div className="mt-3 border-t border-border/50 pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <ArrowLeftRight className="size-4 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">Compare</span>
                      <Select
                        value={diffFromVal}
                        onChange={(e) => setDiffFrom(e.target.value)}
                        className="h-8 w-auto text-xs"
                        aria-label="Diff from snapshot"
                      >
                        {snapshots.data.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.short_id} — {formatWhen(s.time)}
                          </option>
                        ))}
                      </Select>
                      <span className="text-xs text-muted-foreground">→</span>
                      <Select
                        value={diffToVal}
                        onChange={(e) => setDiffTo(e.target.value)}
                        className="h-8 w-auto text-xs"
                        aria-label="Diff to snapshot"
                      >
                        {snapshots.data.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.short_id} — {formatWhen(s.time)}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={diff.isPending || diffFromVal === diffToVal}
                        onClick={() => diff.mutate({ from: diffFromVal, to: diffToVal })}
                      >
                        {diff.isPending && <Loader2 className="animate-spin" />}
                        Diff
                      </Button>
                    </div>
                    {diff.isError && (
                      <p className="mt-2 text-xs text-destructive">
                        {diff.error instanceof ApiError ? diff.error.message : "Diff failed"}
                      </p>
                    )}
                    {diff.data && (
                      <div className="mt-2 rounded-md border p-2 text-xs" data-testid="diff-results">
                        {diff.data.stats && (
                          <p className="text-muted-foreground">
                            {diff.data.stats.changed_files} changed file
                            {diff.data.stats.changed_files === 1 ? "" : "s"} · +
                            {formatBytes(diff.data.stats.added.bytes)} added · −
                            {formatBytes(diff.data.stats.removed.bytes)} removed
                          </p>
                        )}
                        {diff.data.changes.length === 0 ? (
                          <p className="mt-1 text-muted-foreground">No path changes.</p>
                        ) : (
                          <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto font-mono">
                            {diff.data.changes.map((c) => (
                              <li key={c.modifier + c.path} className="break-all">
                                <span
                                  className={
                                    c.modifier.includes("+")
                                      ? "text-green-500"
                                      : c.modifier.includes("-")
                                        ? "text-destructive"
                                        : "text-muted-foreground"
                                  }
                                >
                                  {c.modifier}
                                </span>{" "}
                                {c.path}
                              </li>
                            ))}
                            {diff.data.truncated && (
                              <li className="text-muted-foreground">… list truncated at 1000 entries</li>
                            )}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {otherRepos.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
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
