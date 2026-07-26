import { execSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";

export const E2E_DIR = path.resolve(__dirname, "..");
export const RAW_DIR = path.join(__dirname, "raw");

// Demo credentials/naming shared by both specs. Everything lives in the
// disposable .testenv, so none of these are real secrets.
export const REPO_LOCAL = { name: "nas-local", path: "/repos/nas", password: "pass-nas-local" };
export const REPO_S3 = {
  name: "offsite-s3",
  location: "s3:http://minio:9000/backups",
  password: "pass-offsite-s3",
};
export const PLAN_DOCS = "Documents";
export const PLAN_PHOTOS = "Photos";
export const PLAN_MEDIA = "Media library";

const composeEnv = {
  ...process.env,
  PUID: String(process.getuid?.() ?? 1000),
  PGID: String(process.getgid?.() ?? 1000),
};

export const compose = (args: string) =>
  execSync(`docker compose -f docker-compose.test.yml ${args}`, {
    cwd: E2E_DIR,
    env: composeEnv,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();

// `docker compose exec` enters as root (privileges are only dropped for the
// main process), so run restic as the app's uid — root-owned files written
// into a local repo would be unreadable by the app afterwards.
const execUser = `--user ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} -e RESTIC_CACHE_DIR=/config/cache`;

/** Run restic inside the app container against the local demo repo. */
export function resticLocal(args: string): string {
  return compose(
    `exec -T ${execUser} -e RESTIC_REPOSITORY=${REPO_LOCAL.path} -e RESTIC_PASSWORD=${REPO_LOCAL.password} app restic ${args}`,
  );
}

/** Run restic inside the app container against the MinIO demo repo. */
export function resticS3(args: string): string {
  return compose(
    `exec -T ${execUser} -e RESTIC_REPOSITORY=${REPO_S3.location} -e RESTIC_PASSWORD=${REPO_S3.password} ` +
      `-e AWS_ACCESS_KEY_ID=minioadmin -e AWS_SECRET_ACCESS_KEY=minioadmin123 app restic ${args}`,
  );
}

/** Re-time a snapshot in place; ts is "YYYY-MM-DD HH:MM:SS" (container is UTC). */
export function rewriteSnapshotTime(repo: "local" | "s3", snapshotId: string, ts: string) {
  const args = `rewrite --new-time "${ts}" --forget ${snapshotId}`;
  if (repo === "local") resticLocal(args);
  else resticS3(args);
}

/**
 * Run SQL against the app DB via a throwaway container (no host sqlite3
 * needed). The app must be stopped first — it holds a single WAL connection.
 */
export function runSql(sql: string) {
  const cfgDir = path.join(E2E_DIR, ".testenv", "config");
  writeFileSync(path.join(cfgDir, "backdate.sql"), sql);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  execSync(
    `docker run --rm -v "${cfgDir}:/config" alpine:3.20 sh -c ` +
      `"apk add -q sqlite && sqlite3 /config/restic-ui.db < /config/backdate.sql ` +
      `&& chown ${uid}:${gid} /config/restic-ui.db*"`,
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  rmSync(path.join(cfgDir, "backdate.sql"));
}

// --- host-side source tree helpers (volumes are host-owned) ---

export const sourcesPath = (...p: string[]) => path.join(E2E_DIR, ".testenv", "sources", ...p);

export function writeSource(rel: string, content: string) {
  mkdirSync(path.dirname(sourcesPath(rel)), { recursive: true });
  writeFileSync(sourcesPath(rel), content);
}

export function appendSource(rel: string, content: string) {
  appendFileSync(sourcesPath(rel), content);
}

export function removeSource(rel: string) {
  rmSync(sourcesPath(rel), { force: true, recursive: true });
}

/** Incompressible file of a given size, written in chunks. */
export function randomFile(rel: string, bytes: number) {
  mkdirSync(path.dirname(sourcesPath(rel)), { recursive: true });
  const fd = openSync(sourcesPath(rel), "w");
  for (let left = bytes; left > 0; ) {
    const n = Math.min(left, 8 * 1024 * 1024);
    writeSync(fd, randomBytes(n));
    left -= n;
  }
  closeSync(fd);
}

/** Root-owned unreadable file → genuine restic exit-3 "warning" backup. */
export function makeUnreadable(rel: string) {
  execSync(
    `docker run --rm -v "${sourcesPath()}:/s" alpine:3.20 sh -c ` +
      `"echo placeholder > /s/${rel} && chmod 600 /s/${rel} && chown 0:0 /s/${rel}"`,
    { stdio: ["ignore", "pipe", "inherit"] },
  );
}

export function removeUnreadable(rel: string) {
  execSync(`docker run --rm -v "${sourcesPath()}:/s" alpine:3.20 rm -f /s/${rel}`, {
    stdio: ["ignore", "pipe", "inherit"],
  });
}

// --- API client (session cookie from the page, CSRF from /api/auth/me) ---

export type Api = {
  get: (url: string) => Promise<any>;
  post: (url: string, data?: unknown) => Promise<any>;
  put: (url: string, data?: unknown) => Promise<any>;
};

export async function apiClient(page: Page): Promise<Api> {
  const me = await (await page.request.get("/api/auth/me")).json();
  const headers = { "X-CSRF-Token": me.csrfToken as string };
  const parse = async (res: import("@playwright/test").APIResponse) => {
    if (!res.ok()) throw new Error(`${res.status()} ${res.url()}: ${await res.text()}`);
    return res.json();
  };
  return {
    get: async (url) => parse(await page.request.get(url)),
    post: async (url, data) => parse(await page.request.post(url, { data, headers })),
    put: async (url, data) => parse(await page.request.put(url, { data, headers })),
  };
}

/** Trigger a plan run and poll until the operation reaches a terminal status. */
export async function runPlanAndWait(
  api: Api,
  planId: number,
  timeoutMs = 180_000,
): Promise<{ opId: number; status: string }> {
  const op = await api.post(`/api/plans/${planId}/run`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cur = await api.get(`/api/operations/${op.id}`);
    if (["success", "warning", "error", "canceled"].includes(cur.status)) {
      return { opId: op.id, status: cur.status };
    }
    if (Date.now() > deadline) throw new Error(`op ${op.id} did not finish in time`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Newest snapshot id in a repo (the API returns newest-first). */
export async function latestSnapshotId(api: Api, repoId: number): Promise<string> {
  const snaps = await api.get(`/api/repos/${repoId}/snapshots`);
  return snaps[0].id;
}

// --- time formatting ---

/** RFC3339 UTC without milliseconds — the format the Go backend writes. */
export const rfc3339 = (d: Date) => d.toISOString().slice(0, 19) + "Z";

/** "YYYY-MM-DD HH:MM:SS" (UTC) for restic --new-time inside the UTC container. */
export const resticTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/** UTC datetime `daysAgo` days before today at hh:mm:ss. */
export function dayAt(daysAgo: number, h: number, m = 0, s = 0): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, h, m, s));
}

/**
 * SQL that shifts one operation (and its logs + stats point) so it appears to
 * have started at `target` while keeping its real duration.
 */
export function backdateOpSql(
  opId: number,
  origStartIso: string,
  origEndIso: string,
  target: Date,
): string {
  const origStart = new Date(origStartIso);
  const origEnd = new Date(origEndIso);
  const shiftSec = Math.round((origStart.getTime() - target.getTime()) / 1000);
  const newStart = rfc3339(target);
  const newEnd = rfc3339(new Date(origEnd.getTime() - shiftSec * 1000));
  const captured = rfc3339(new Date(origEnd.getTime() - shiftSec * 1000 + 1000));
  return [
    `UPDATE operations SET created_at='${newStart}', started_at='${newStart}', ended_at='${newEnd}' WHERE id=${opId};`,
    `UPDATE operation_logs SET ts=strftime('%Y-%m-%dT%H:%M:%SZ', datetime(ts, '-${shiftSec} seconds')) WHERE operation_id=${opId};`,
    `UPDATE repo_stats_history SET captured_at='${captured}' WHERE operation_id=${opId};`,
  ].join("\n");
}
