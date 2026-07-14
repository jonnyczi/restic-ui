import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Activity, AlertTriangle, CalendarClock, Database, ListTodo, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import Sparkline from "@/components/Sparkline";
import StatusBadge from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { formatBytes, formatWhen, type Dashboard } from "@/lib/types";

function Tile({
  icon,
  label,
  value,
  alert,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  alert?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`rounded-md p-2 ${alert && value > 0 ? "bg-destructive/15 text-destructive" : "bg-secondary text-muted-foreground"}`}>
          {icon}
        </div>
        <div>
          <div className="text-2xl font-semibold leading-none">{value}</div>
          <div className="mt-1 text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<Dashboard>("/api/dashboard"),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Your backups at a glance.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile icon={<Database className="size-5" />} label="Repositories" value={data.repoCount} />
        <Tile icon={<ListTodo className="size-5" />} label="Backup plans" value={data.planCount} />
        <Tile icon={<Activity className="size-5" />} label="Running now" value={data.runningOps} />
        <Tile
          icon={<AlertTriangle className="size-5" />}
          label="Issues (24h)"
          value={data.issues24h}
          alert
        />
      </div>

      {data.repoGrowth.some((g) => g.points.length >= 2) && (
        <div>
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Repository growth</h2>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="repo-growth">
            {data.repoGrowth.map((g) => {
              const latest = g.points[g.points.length - 1];
              const delta = latest.size - g.points[0].size;
              return (
                <Card key={g.repoId}>
                  <CardContent className="p-4">
                    <div className="truncate text-xs text-muted-foreground">{g.repoName}</div>
                    <div className="mt-0.5 flex items-baseline gap-2">
                      <span className="font-semibold">{formatBytes(latest.size)}</span>
                      {delta !== 0 && (
                        <span className="text-xs text-muted-foreground">
                          {delta > 0 ? "+" : "−"}
                          {formatBytes(Math.abs(delta))}
                        </span>
                      )}
                    </div>
                    <div className="mt-2">
                      <Sparkline
                        points={g.points.map((p) => p.size)}
                        ariaLabel={`${g.repoName} size over ${g.points.length} measurements`}
                      />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {data.plans.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                <th className="p-2 font-medium">Plan</th>
                <th className="hidden p-2 font-medium md:table-cell">Repository</th>
                <th className="p-2 font-medium">Last run</th>
                <th className="p-2 font-medium">Status</th>
                <th className="hidden p-2 font-medium md:table-cell">Next run</th>
                <th className="hidden w-28 p-2 font-medium md:table-cell">Duration trend</th>
              </tr>
            </thead>
            <tbody>
              {data.plans.map((p) => (
                <tr key={p.id} className="border-b border-border/50 last:border-0">
                  <td className="p-2">
                    <Link to="/plans" className="hover:underline">
                      {p.name}
                    </Link>
                    {!p.enabled && (
                      <span className="ml-2 text-xs text-muted-foreground">(disabled)</span>
                    )}
                    {p.overdue && p.enabled && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-500">
                        <AlertTriangle className="size-3" /> overdue
                      </span>
                    )}
                  </td>
                  <td className="hidden p-2 text-muted-foreground md:table-cell">{p.repoName}</td>
                  <td className="p-2 text-muted-foreground">
                    {p.lastRun ? formatWhen(p.lastRun) : "never"}
                  </td>
                  <td className="p-2">{p.lastStatus ? <StatusBadge status={p.lastStatus} /> : "—"}</td>
                  <td className="hidden p-2 text-muted-foreground md:table-cell">
                    {p.nextRun ? (
                      <span className="flex items-center gap-1">
                        <CalendarClock className="size-3.5" />
                        {formatWhen(p.nextRun)}
                      </span>
                    ) : (
                      "manual"
                    )}
                  </td>
                  <td className="hidden p-2 md:table-cell">
                    {(data.planDurations[p.id]?.length ?? 0) >= 2 ? (
                      <span
                        title={`last backup took ${Math.round(
                          data.planDurations[p.id][data.planDurations[p.id].length - 1].seconds,
                        )}s`}
                      >
                        <Sparkline
                          points={data.planDurations[p.id].map((d) => d.seconds)}
                          height={20}
                          ariaLabel={`${p.name} backup duration trend`}
                        />
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.recentOps.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Recent activity</h2>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <tbody>
                {data.recentOps.map((op) => (
                  <tr key={op.id} className="border-b border-border/50 last:border-0">
                    <td className="p-2">{op.type}</td>
                    <td className="p-2 text-muted-foreground">{op.planName || op.repoName || "—"}</td>
                    <td className="p-2">
                      <StatusBadge status={op.status} />
                    </td>
                    <td className="p-2 text-right text-muted-foreground">
                      {op.startedAt ? formatWhen(op.startedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Link to="/operations" className="mt-2 inline-block text-sm text-muted-foreground hover:underline">
            View all operations →
          </Link>
        </div>
      )}

      {data.planCount === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="font-medium">Welcome to restic-ui</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Start by adding a <Link className="underline" to="/repos">repository</Link>, then create
            a <Link className="underline" to="/plans">backup plan</Link>.
          </p>
        </div>
      )}
    </div>
  );
}
