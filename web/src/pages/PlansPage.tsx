import { useState } from "react";
import { CalendarClock, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import PlanForm from "@/components/plans/PlanForm";
import { useDeletePlan, usePlans, useRunPlan, useSetPlanEnabled } from "@/hooks/usePlans";
import type { Plan } from "@/lib/types";

function PlanCard({ plan, onEdit }: { plan: Plan; onEdit: () => void }) {
  const run = useRunPlan();
  const del = useDeletePlan();
  const setEnabled = useSetPlanEnabled();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [started, setStarted] = useState(false);

  return (
    <Card data-testid={`plan-${plan.name}`} className={plan.enabled ? "" : "opacity-60"}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-semibold">{plan.name}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>→ {plan.repoName}</span>
              <span className="flex items-center gap-1">
                <CalendarClock className="size-3.5" />
                {plan.scheduleCron ? (
                  <>
                    <code className="text-xs">{plan.scheduleCron}</code>
                    {plan.nextRun && (
                      <span className="text-xs">
                        (next: {new Date(plan.nextRun).toLocaleString()})
                      </span>
                    )}
                  </>
                ) : (
                  "manual only"
                )}
              </span>
              {plan.tags.length > 0 && <span>tags: {plan.tags.join(", ")}</span>}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={plan.enabled}
                onChange={(e) => setEnabled.mutate({ id: plan.id, enabled: e.target.checked })}
                className="accent-primary"
              />
              Enabled
            </label>
            <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit plan">
              <Pencil />
            </Button>
            {confirmDelete ? (
              <>
                <Button size="sm" variant="destructive" onClick={() => del.mutate(plan.id)}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
                aria-label="Delete plan"
              >
                <Trash2 />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-sm">
          <span className="text-muted-foreground">Sources: </span>
          <code className="text-xs">{plan.sources.join("  ·  ")}</code>
        </div>
        {plan.excludes.length > 0 && (
          <div className="text-sm">
            <span className="text-muted-foreground">Excludes: </span>
            <code className="text-xs">{plan.excludes.join("  ·  ")}</code>
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            disabled={run.isPending}
            onClick={async () => {
              setStarted(false);
              await run.mutateAsync(plan.id);
              setStarted(true);
            }}
          >
            {run.isPending ? <Loader2 className="animate-spin" /> : <Play />}
            Run now
          </Button>
          {started && (
            <span role="status" className="text-sm text-green-500">
              Backup started — follow it on the Operations page.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function PlansPage() {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const { data: plans, isLoading } = usePlans();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Backup plans</h1>
          <p className="text-sm text-muted-foreground">
            What gets backed up, where to, and on what schedule.
          </p>
        </div>
        {!adding && !editing && (
          <Button onClick={() => setAdding(true)}>
            <Plus />
            Add plan
          </Button>
        )}
      </div>

      {adding && <PlanForm onDone={() => setAdding(false)} />}
      {editing && <PlanForm existing={editing} onDone={() => setEditing(null)} />}

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      )}

      {plans && plans.length === 0 && !adding && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="font-medium">No backup plans yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create one to schedule backups of your folders into a repository.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {plans?.map((p) => (
          <PlanCard key={p.id} plan={p} onEdit={() => setEditing(p)} />
        ))}
      </div>
    </div>
  );
}
