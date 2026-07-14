import { useEffect, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { FolderSearch, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import DirBrowser from "@/components/plans/DirBrowser";
import { useCreatePlan, useUpdatePlan } from "@/hooks/usePlans";
import { useRepos } from "@/hooks/useRepos";
import { api, ApiError } from "@/lib/api";
import { humanizeCron, SCHEDULE_PRESETS } from "@/lib/cronHumanize";
import {
  formatBytes,
  formatWhen,
  type BackupOptions,
  type BackupPreview,
  type ForgetGroup,
  type Plan,
  type PlanInput,
  type Retention,
} from "@/lib/types";

/** Create/edit form for a backup plan. */
export default function PlanForm({
  existing,
  onDone,
}: {
  existing?: Plan;
  onDone: () => void;
}) {
  const { data: repos } = useRepos();
  const create = useCreatePlan();
  const update = useUpdatePlan();

  const initialPreset = existing
    ? SCHEDULE_PRESETS.some((p) => p.value === existing.scheduleCron)
      ? existing.scheduleCron
      : "custom"
    : "";

  const [sources, setSources] = useState<string[]>(existing?.sources ?? []);
  const [excludes, setExcludes] = useState<string[]>(existing?.excludes ?? []);
  const [tags, setTags] = useState<string[]>(existing?.tags ?? []);
  const [preset, setPreset] = useState(initialPreset);
  const [customCron, setCustomCron] = useState(
    initialPreset === "custom" ? (existing?.scheduleCron ?? "") : "",
  );
  const [browsing, setBrowsing] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [excludeInput, setExcludeInput] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState("");
  const [retention, setRetention] = useState<Retention>(existing?.retention ?? {});
  const [prune, setPrune] = useState(existing?.retention?.prune ?? true);
  const [repoId, setRepoId] = useState<number | "">(existing?.repoId ?? "");
  const [preview, setPreview] = useState<ForgetGroup[] | null>(null);
  const [options, setOptions] = useState<BackupOptions>(existing?.options ?? {});
  const [dryRun, setDryRun] = useState<BackupPreview | null>(null);

  // Match the old native-select behavior: default to the first repo for new
  // plans once the list loads, instead of forcing an explicit empty choice.
  useEffect(() => {
    if (!existing && repoId === "" && repos && repos.length > 0) {
      setRepoId(repos[0].id);
    }
  }, [repos, existing, repoId]);

  const busy = create.isPending || update.isPending;
  const hasRetention = Object.values(retention).some((v) => typeof v === "number" && v > 0);

  const previewRetention = useMutation({
    mutationFn: () =>
      api.post<ForgetGroup[]>("/api/plans/retention-preview", {
        repoId: Number(repoId),
        sources,
        retention: { ...retention, prune },
      }),
    onSuccess: setPreview,
  });

  const previewBackup = useMutation({
    mutationFn: () =>
      api.post<BackupPreview>("/api/plans/dry-run", {
        repoId: Number(repoId),
        sources,
        excludes,
        options,
      }),
    onSuccess: setDryRun,
  });

  function addSource(path: string) {
    const p = path.trim();
    if (p && !sources.includes(p)) setSources([...sources, p]);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget);
    const input: PlanInput = {
      name: (f.get("name") as string).trim(),
      repoId: Number(repoId),
      sources,
      excludes,
      tags,
      scheduleCron: preset === "custom" ? customCron.trim() : preset,
      retention: hasRetention ? { ...retention, prune } : {},
      options,
      enabled: f.get("enabled") === "on",
      notifyMuted: f.get("notifyMuted") === "on",
    };
    try {
      if (existing) {
        await update.mutateAsync({ id: existing.id, input });
      } else {
        await create.mutateAsync(input);
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed");
    }
  }

  const chipList = (
    items: string[],
    setItems: (v: string[]) => void,
    mono = true,
  ) =>
    items.length > 0 && (
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => (
          <span
            key={it}
            className={`inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-xs ${mono ? "font-mono" : ""}`}
          >
            {it}
            <button
              type="button"
              onClick={() => setItems(items.filter((x) => x !== it))}
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${it}`}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{existing ? `Edit plan: ${existing.name}` : "Add backup plan"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue={existing?.name} placeholder="e.g. appdata nightly" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="repoId">Repository</Label>
              <Select
                id="repoId"
                name="repoId"
                value={repoId}
                onChange={(e) => setRepoId(Number(e.target.value))}
                required
              >
                {(repos ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.backendType})
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Source folders</Label>
            {chipList(sources, setSources)}
            <div className="flex flex-wrap gap-2">
              <Input
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                placeholder="/sources/photos"
                data-testid="source-input"
                className="w-auto min-w-40 flex-1"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  addSource(manualPath);
                  setManualPath("");
                }}
              >
                Add
              </Button>
              <Button type="button" variant="outline" onClick={() => setBrowsing((v) => !v)}>
                <FolderSearch />
                Browse
              </Button>
            </div>
            {browsing && (
              <DirBrowser
                onSelect={(p) => {
                  addSource(p);
                  setBrowsing(false);
                }}
                onClose={() => setBrowsing(false)}
              />
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="exclude">Exclude patterns</Label>
              <p className="text-xs text-muted-foreground">
                Shell-style globs: <code>*.tmp</code> matches any file ending in .tmp,{" "}
                <code>**/cache</code> matches a "cache" folder at any depth, and a leading{" "}
                <code>/</code> anchors the pattern to the source folder's root.
              </p>
              {chipList(excludes, setExcludes)}
              <div className="flex gap-2">
                <Input
                  id="exclude"
                  value={excludeInput}
                  onChange={(e) => setExcludeInput(e.target.value)}
                  placeholder="*.tmp, node_modules…"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    const v = excludeInput.trim();
                    if (v && !excludes.includes(v)) setExcludes([...excludes, v]);
                    setExcludeInput("");
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tag">Tags</Label>
              {chipList(tags, setTags, false)}
              <div className="flex gap-2">
                <Input
                  id="tag"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  placeholder="nightly"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    const v = tagInput.trim();
                    if (v && !tags.includes(v)) setTags([...tags, v]);
                    setTagInput("");
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="schedule">Schedule</Label>
              <Select id="schedule" value={preset} onChange={(e) => setPreset(e.target.value)}>
                {SCHEDULE_PRESETS.map((p) => (
                  <option key={p.label} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
            {preset === "custom" && (
              <div className="space-y-2">
                <Label htmlFor="customCron">Cron expression (min hour dom mon dow)</Label>
                <Input
                  id="customCron"
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="30 4 * * 1-5"
                  className="font-mono"
                />
                {customCron.trim() && (
                  <p className="text-xs text-muted-foreground">{humanizeCron(customCron)}</p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <Label>Backup options</Label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="uploadLimit" className="text-xs text-muted-foreground">
                  Upload limit (KiB/s, 0 = unlimited)
                </Label>
                <Input
                  id="uploadLimit"
                  type="number"
                  min={0}
                  value={options.uploadLimitKiB ?? ""}
                  onChange={(e) =>
                    setOptions({ ...options, uploadLimitKiB: Number(e.target.value) || 0 })
                  }
                  placeholder="0"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="downloadLimit" className="text-xs text-muted-foreground">
                  Download limit (KiB/s, 0 = unlimited)
                </Label>
                <Input
                  id="downloadLimit"
                  type="number"
                  min={0}
                  value={options.downloadLimitKiB ?? ""}
                  onChange={(e) =>
                    setOptions({ ...options, downloadLimitKiB: Number(e.target.value) || 0 })
                  }
                  placeholder="0"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-6">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={options.excludeCaches ?? false}
                  onChange={(e) => setOptions({ ...options, excludeCaches: e.target.checked })}
                  className="accent-primary"
                />
                Skip cache dirs (CACHEDIR.TAG)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={options.oneFileSystem ?? false}
                  onChange={(e) => setOptions({ ...options, oneFileSystem: e.target.checked })}
                  className="accent-primary"
                />
                Don't cross filesystem boundaries
              </label>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!repoId || sources.length === 0 || previewBackup.isPending}
                onClick={() => {
                  setDryRun(null);
                  previewBackup.mutate();
                }}
              >
                {previewBackup.isPending && <Loader2 className="animate-spin" />}
                Dry-run this backup
              </Button>
              {previewBackup.isError && (
                <span className="text-xs text-destructive">
                  {previewBackup.error instanceof ApiError
                    ? previewBackup.error.message
                    : "Dry-run failed"}
                </span>
              )}
            </div>
            {dryRun && (
              <div className="rounded-md border bg-background p-2 text-xs" data-testid="dry-run-result">
                <p className="text-muted-foreground">
                  Would add <b className="text-foreground">{formatBytes(dryRun.data_added)}</b> —{" "}
                  {dryRun.files_new} new, {dryRun.files_changed} changed, {dryRun.files_unmodified}{" "}
                  unchanged file{dryRun.files_unmodified === 1 ? "" : "s"}.
                </p>
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <Label>Retention — how many snapshots to keep (0 = ignore)</Label>
            <p className="text-xs text-muted-foreground">
              Each bucket keeps its most recent N matching snapshots — e.g. Daily=7 keeps one
              snapshot for each of the last 7 days that had one, Weekly=4 the last 4 distinct
              weeks. Buckets combine (a snapshot can count toward Daily and Weekly at once), and
              anything outside every bucket is removed the next time this policy applies.
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {(
                [
                  ["keepLast", "Last"],
                  ["keepDaily", "Daily"],
                  ["keepWeekly", "Weekly"],
                  ["keepMonthly", "Monthly"],
                  ["keepYearly", "Yearly"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={key} className="text-xs text-muted-foreground">
                    {label}
                  </Label>
                  <Input
                    id={key}
                    type="number"
                    min={0}
                    value={retention[key] ?? ""}
                    onChange={(e) =>
                      setRetention({ ...retention, [key]: Number(e.target.value) || 0 })
                    }
                    placeholder="0"
                  />
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prune}
                onChange={(e) => setPrune(e.target.checked)}
                className="accent-primary"
              />
              Prune after forget (reclaims disk space; can take a while)
            </label>
            <p className="text-xs text-muted-foreground">
              Applied automatically after each successful backup of this plan.
            </p>
            <div className="flex items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!hasRetention || !repoId || sources.length === 0 || previewRetention.isPending}
                onClick={() => {
                  setPreview(null);
                  previewRetention.mutate();
                }}
              >
                {previewRetention.isPending && <Loader2 className="animate-spin" />}
                Preview what this would keep
              </Button>
              {previewRetention.isError && (
                <span className="text-xs text-destructive">
                  {previewRetention.error instanceof ApiError
                    ? previewRetention.error.message
                    : "Preview failed"}
                </span>
              )}
            </div>
            {preview && (
              <div className="rounded-md border bg-background p-2 text-xs">
                {(() => {
                  const keep = preview.reduce((n, g) => n + g.keep.length, 0);
                  const remove = preview.flatMap((g) => g.remove);
                  return (
                    <>
                      <p className="text-muted-foreground">
                        Would keep <b className="text-foreground">{keep}</b> snapshot
                        {keep === 1 ? "" : "s"} and remove{" "}
                        <b className="text-foreground">{remove.length}</b>.
                      </p>
                      {remove.length > 0 && (
                        <ul className="mt-1 space-y-0.5 font-mono text-muted-foreground">
                          {remove.map((s) => (
                            <li key={s.id}>
                              {s.short_id} — {formatWhen(s.time)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={existing?.enabled ?? true}
                className="accent-primary"
              />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="notifyMuted"
                defaultChecked={existing?.notifyMuted ?? false}
                className="accent-primary"
              />
              Mute notifications for this plan
            </label>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {existing ? "Save changes" : "Create plan"}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
