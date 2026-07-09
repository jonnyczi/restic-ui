import { useState, type FormEvent } from "react";
import { FolderSearch, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import DirBrowser from "@/components/plans/DirBrowser";
import { useCreatePlan, useUpdatePlan } from "@/hooks/usePlans";
import { useRepos } from "@/hooks/useRepos";
import { ApiError } from "@/lib/api";
import type { Plan, PlanInput, Retention } from "@/lib/types";

const SCHEDULE_PRESETS = [
  { label: "Manual only (no schedule)", value: "" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Daily at 02:00", value: "0 2 * * *" },
  { label: "Weekly, Sunday 03:00", value: "0 3 * * 0" },
  { label: "Custom cron…", value: "custom" },
];

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

  const busy = create.isPending || update.isPending;

  function addSource(path: string) {
    const p = path.trim();
    if (p && !sources.includes(p)) setSources([...sources, p]);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget);
    const hasRetention = Object.values(retention).some((v) => typeof v === "number" && v > 0);
    const input: PlanInput = {
      name: (f.get("name") as string).trim(),
      repoId: Number(f.get("repoId")),
      sources,
      excludes,
      tags,
      scheduleCron: preset === "custom" ? customCron.trim() : preset,
      retention: hasRetention ? { ...retention, prune } : {},
      enabled: f.get("enabled") === "on",
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
              <Select id="repoId" name="repoId" defaultValue={existing?.repoId} required>
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
            <div className="flex gap-2">
              <Input
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                placeholder="/sources/photos"
                data-testid="source-input"
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
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <Label>Retention — how many snapshots to keep (0 = ignore)</Label>
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
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={existing?.enabled ?? true}
              className="accent-primary"
            />
            Enabled
          </label>

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
