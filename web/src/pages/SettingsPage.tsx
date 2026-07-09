import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api";
import type { NotifySettings } from "@/lib/types";

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<NotifySettings>("/api/settings"),
  });

  const [form, setForm] = useState<NotifySettings>({
    appriseApiUrl: "",
    appriseUrls: "",
    notifyOnSuccess: false,
    notifyOnFailure: true,
  });
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const save = useMutation({
    mutationFn: (input: NotifySettings) => api.put<NotifySettings>("/api/settings", input),
    onSuccess: (data) => {
      qc.setQueryData(["settings"], data);
      setNotice({ kind: "ok", text: "Settings saved." });
    },
    onError: (err) =>
      setNotice({ kind: "err", text: err instanceof ApiError ? err.message : "Save failed" }),
  });

  const test = useMutation({
    mutationFn: () => api.post("/api/notifications/test"),
    onSuccess: () => setNotice({ kind: "ok", text: "Test notification sent — check your service." }),
    onError: (err) =>
      setNotice({ kind: "err", text: err instanceof ApiError ? err.message : "Test failed" }),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    save.mutate(form);
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Notifications and app configuration.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BellRing className="size-4" /> Notifications
          </CardTitle>
          <CardDescription>
            restic-ui sends notifications through an{" "}
            <a
              className="underline"
              href="https://github.com/caronc/apprise-api"
              target="_blank"
              rel="noreferrer"
            >
              Apprise API
            </a>{" "}
            server (e.g. the <code>linuxserver/apprise-api</code> container), which supports 80+
            services: Discord, Telegram, ntfy, email, and more.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="appriseApiUrl">Apprise API server URL</Label>
              <Input
                id="appriseApiUrl"
                placeholder="http://apprise:8000"
                value={form.appriseApiUrl}
                onChange={(e) => setForm({ ...form, appriseApiUrl: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Leave empty to disable notifications.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="appriseUrls">Notification service URLs (one per line)</Label>
              <Textarea
                id="appriseUrls"
                rows={3}
                placeholder={"discord://webhook_id/webhook_token\nntfys://ntfy.sh/my-topic"}
                value={form.appriseUrls}
                onChange={(e) => setForm({ ...form, appriseUrls: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Optional — if empty, the Apprise server's default configuration is used.
              </p>
            </div>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.notifyOnFailure}
                  onChange={(e) => setForm({ ...form, notifyOnFailure: e.target.checked })}
                  className="accent-primary"
                />
                Notify on failure
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.notifyOnSuccess}
                  onChange={(e) => setForm({ ...form, notifyOnSuccess: e.target.checked })}
                  className="accent-primary"
                />
                Notify on success
              </label>
            </div>

            {notice && (
              <p
                role="status"
                className={`text-sm ${notice.kind === "ok" ? "text-green-500" : "text-destructive"}`}
              >
                {notice.text}
              </p>
            )}

            <div className="flex gap-2">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}
                Save
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={test.isPending || !form.appriseApiUrl}
                onClick={() => {
                  setNotice(null);
                  test.mutate();
                }}
              >
                {test.isPending && <Loader2 className="animate-spin" />}
                Send test notification
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
