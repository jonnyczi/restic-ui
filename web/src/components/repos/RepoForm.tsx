import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCreateRepo, useRepoAction } from "@/hooks/useRepos";
import { ApiError } from "@/lib/api";
import { humanizeCron, SCHEDULE_PRESETS } from "@/lib/cronHumanize";
import type { BackendType, RepoInput } from "@/lib/types";

const CHECK_PRESETS = SCHEDULE_PRESETS.map((p) =>
  p.value === "" ? { ...p, label: "No automatic checks" } : p,
);

const BACKEND_LABELS: Record<BackendType, string> = {
  local: "Local path",
  s3: "S3-compatible",
  sftp: "SFTP",
  rclone: "rclone",
};

/** Create-repository form with per-backend fields. */
export default function RepoForm({ onDone }: { onDone: () => void }) {
  const [backend, setBackend] = useState<BackendType>("local");
  const [autoInit, setAutoInit] = useState(true);
  const [checkPreset, setCheckPreset] = useState("");
  const [checkCron, setCheckCron] = useState("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<"idle" | "creating" | "initializing">("idle");

  const create = useCreateRepo();
  const action = useRepoAction();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget);
    const str = (k: string) => (f.get(k) as string | null)?.trim() ?? "";

    const input: RepoInput = {
      name: str("name"),
      backendType: backend,
      password: str("password"),
      config: {},
      secrets: {},
      checkScheduleCron: checkPreset === "custom" ? checkCron.trim() : checkPreset,
    };
    switch (backend) {
      case "local":
        input.config.path = str("path");
        break;
      case "s3":
        input.config.endpoint = str("endpoint");
        input.config.bucket = str("bucket");
        input.config.prefix = str("prefix");
        input.config.region = str("region");
        input.config.accessKeyId = str("accessKeyId");
        input.config.useHttp = f.get("useHttp") === "on";
        input.secrets.secretAccessKey = str("secretAccessKey");
        break;
      case "sftp":
        input.config.host = str("host");
        input.config.port = str("sftpPort") ? Number(str("sftpPort")) : 22;
        input.config.user = str("user");
        input.config.path = str("path");
        input.secrets.privateKey = (f.get("privateKey") as string) ?? "";
        break;
      case "rclone":
        input.config.remote = str("remote");
        input.config.path = str("path");
        input.secrets.rcloneConf = (f.get("rcloneConf") as string) ?? "";
        break;
    }

    try {
      setPhase("creating");
      const repo = await create.mutateAsync(input);
      if (autoInit) {
        setPhase("initializing");
        await action.mutateAsync({ id: repo.id, action: "init" });
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setPhase("idle");
    }
  }

  const busy = phase !== "idle";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add repository</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="e.g. NAS offsite" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backendType">Backend</Label>
              <Select
                id="backendType"
                value={backend}
                onChange={(e) => setBackend(e.target.value as BackendType)}
              >
                {Object.entries(BACKEND_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {backend === "local" && (
            <div className="space-y-2">
              <Label htmlFor="path">Repository path (inside the container)</Label>
              <Input id="path" name="path" placeholder="/repos/my-backup" required />
              <p className="text-xs text-muted-foreground">
                Mount a host directory into the container and point this at it.
              </p>
            </div>
          )}

          {backend === "s3" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="endpoint">Endpoint (host[:port], no scheme)</Label>
                  <Input id="endpoint" name="endpoint" placeholder="s3.amazonaws.com" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bucket">Bucket</Label>
                  <Input id="bucket" name="bucket" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="prefix">Prefix (optional)</Label>
                  <Input id="prefix" name="prefix" placeholder="restic/host1" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="region">Region (optional)</Label>
                  <Input id="region" name="region" placeholder="us-east-1" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="accessKeyId">Access key ID</Label>
                  <Input id="accessKeyId" name="accessKeyId" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="secretAccessKey">Secret access key</Label>
                  <Input id="secretAccessKey" name="secretAccessKey" type="password" required />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="useHttp" className="accent-primary" />
                Use plain HTTP (unencrypted — LAN MinIO only)
              </label>
            </>
          )}

          {backend === "sftp" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="host">Host</Label>
                  <Input id="host" name="host" placeholder="nas.local" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sftpPort">Port</Label>
                  <Input id="sftpPort" name="sftpPort" type="number" placeholder="22" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="user">User</Label>
                  <Input id="user" name="user" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="path">Path (/abs or relative to home)</Label>
                  <Input id="path" name="path" placeholder="/tank/restic" required />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="privateKey">SSH private key (optional, PEM)</Label>
                <Textarea id="privateKey" name="privateKey" rows={4} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                <p className="text-xs text-muted-foreground">
                  Stored encrypted. Without a key, the container's SSH agent/config is used.
                </p>
              </div>
            </>
          )}

          {backend === "rclone" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="remote">Remote name</Label>
                  <Input id="remote" name="remote" placeholder="gdrive" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="path">Path on remote</Label>
                  <Input id="path" name="path" placeholder="backups/host1" required />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="rcloneConf">rclone.conf content (optional)</Label>
                <Textarea id="rcloneConf" name="rcloneConf" rows={5} placeholder={"[gdrive]\ntype = drive\n..."} />
                <p className="text-xs text-muted-foreground">
                  Paste the config section for this remote. Stored encrypted.
                </p>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="password">Repository password</Label>
            <Input id="password" name="password" type="password" required />
            <p className="text-xs text-muted-foreground">
              Encrypts your backups. Store it somewhere safe — without it the data is unrecoverable.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="checkSchedule">Integrity check schedule</Label>
              <Select
                id="checkSchedule"
                value={checkPreset}
                onChange={(e) => setCheckPreset(e.target.value)}
              >
                {CHECK_PRESETS.map((p) => (
                  <option key={p.label} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Periodically runs <code>restic check</code> to verify repository integrity.
              </p>
            </div>
            {checkPreset === "custom" && (
              <div className="space-y-2">
                <Label htmlFor="checkCron">Cron expression (min hour dom mon dow)</Label>
                <Input
                  id="checkCron"
                  value={checkCron}
                  onChange={(e) => setCheckCron(e.target.value)}
                  placeholder="0 5 * * 0"
                  className="font-mono"
                />
                {checkCron.trim() && (
                  <p className="text-xs text-muted-foreground">{humanizeCron(checkCron)}</p>
                )}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoInit}
              onChange={(e) => setAutoInit(e.target.checked)}
              className="accent-primary"
            />
            Initialize repository after creating (uncheck when adding an existing repo)
          </label>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {phase === "initializing" ? "Initializing…" : "Create"}
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
