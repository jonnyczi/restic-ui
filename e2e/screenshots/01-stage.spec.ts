import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { resetEnv, setupAdmin } from "../helpers";
import {
  apiClient,
  appendSource,
  backdateOpSql,
  compose,
  dayAt,
  latestSnapshotId,
  makeUnreadable,
  PLAN_DOCS,
  PLAN_MEDIA,
  PLAN_PHOTOS,
  randomFile,
  removeSource,
  removeUnreadable,
  REPO_LOCAL,
  REPO_S3,
  resticLocal,
  resticTime,
  rewriteSnapshotTime,
  runPlanAndWait,
  runSql,
  RAW_DIR,
  writeSource,
  type Api,
} from "./stage-helpers";

// Stages the demo environment for the README screenshots:
//
//  1. resetEnv (DESTROYS e2e/.testenv — never run alongside `make e2e`),
//     richer source tree, admin account (the first-run "setup" shot is taken
//     here because it can't be reproduced once the admin exists).
//  2. Two repos + three plans, then 18 backups run through the real app in
//     fake-chronological order (op ids must match the fake timeline), with
//     per-run source mutations and one genuine warning run (unreadable file).
//  3. Backdating: restic rewrite --new-time per snapshot, then SQL shifts of
//     operations/logs/stats (durations preserved) while the app is stopped.
//  4. Retention policies (added only AFTER backdating — a retention run
//     during staging would collapse the same-day snapshots), check schedule,
//     one real check op, notification settings.

test.describe.configure({ mode: "serial" });

type Backup = {
  plan: "docs" | "photos" | "media";
  target: Date;
  opId?: number;
  snapshotId?: string;
};

// Fake timeline, oldest first. Docs run daily at 02:00 (with believable
// gaps), photos three times at 03:00, media once manually in the evening.
// The two scheduled plans' last runs sit at T-1 so the dashboard's overdue
// heuristic (2 days grace) stays green.
const TIMELINE: Backup[] = [
  { plan: "docs", target: dayAt(18, 2) },
  { plan: "docs", target: dayAt(17, 2) },
  { plan: "docs", target: dayAt(16, 2) },
  { plan: "docs", target: dayAt(15, 2) },
  { plan: "photos", target: dayAt(15, 3) },
  { plan: "docs", target: dayAt(14, 2) },
  { plan: "docs", target: dayAt(12, 2) },
  { plan: "docs", target: dayAt(11, 2) },
  { plan: "docs", target: dayAt(10, 2) },
  { plan: "docs", target: dayAt(9, 2) }, // warning run (unreadable file)
  { plan: "docs", target: dayAt(8, 2) },
  { plan: "photos", target: dayAt(8, 3) },
  { plan: "docs", target: dayAt(6, 2) },
  { plan: "docs", target: dayAt(5, 2) },
  { plan: "docs", target: dayAt(3, 2) },
  { plan: "media", target: dayAt(2, 21, 30) },
  { plan: "docs", target: dayAt(1, 2) },
  { plan: "photos", target: dayAt(1, 3) },
];
const WARNING_INDEX = TIMELINE.findIndex((b) => b.plan === "docs" && b.target.getTime() === dayAt(9, 2).getTime());

function seedSources() {
  writeSource("docs/projects/roadmap.md", "# Homelab roadmap\n\n- Q1: consolidate storage\n- Q2: offsite backups\n");
  writeSource("docs/notes/worklog.md", "# Worklog\n");
  writeSource("docs/notes/ideas.md", "- self-hosted photo sync\n- wiki for the family\n");
  for (let i = 1; i <= 6; i++) {
    randomFile(`photos/2024/img_${String(i).padStart(3, "0")}.jpg`, (1200 + i * 173) * 1024);
  }
  randomFile("media/movies/home-video-2019.mp4", 120 * 1024 * 1024);
  for (let i = 1; i <= 4; i++) {
    randomFile(`media/music/album/track-${i}.flac`, 8 * 1024 * 1024);
  }
}

/** Per-run source changes so every snapshot differs and the repo grows. */
function mutateDocs(run: number) {
  appendSource("docs/notes/worklog.md", `\n## Entry ${run}\n- reviewed drafts, filed scans\n`);
  if (run % 2 === 0) randomFile(`docs/archive/scan-${String(run).padStart(2, "0")}.pdf`, (200 + run * 120) * 1024);
  if (run === 3) randomFile("docs/projects/budget-2026.ods", 240 * 1024);
  if (run === 5) randomFile("docs/archive/contract-2019.pdf", 3 * 1024 * 1024);
  if (run === 12) randomFile("docs/projects/tax-return-2025.pdf", 850 * 1024);
  if (run === 14) {
    // Rich final change set so the snapshot-diff shot shows +/−/M variety.
    writeSource("docs/projects/q3-planning.md", "# Q3 planning\n\n- migrate NAS pool\n- verify offsite restores\n");
    appendSource("docs/projects/roadmap.md", "- Q3: automate restore verification\n");
    removeSource("docs/archive/scan-04.pdf");
  }
}

function mutatePhotos(run: number) {
  randomFile(`photos/2025/img_${String(100 + run * 2)}.jpg`, (1700 + run * 211) * 1024);
  randomFile(`photos/2025/img_${String(101 + run * 2)}.jpg`, (1400 + run * 149) * 1024);
}

let page: Page;
let api: Api;
const planIds: Record<string, number> = {};

test.beforeAll(async ({ browser }) => {
  mkdirSync(RAW_DIR, { recursive: true });
  page = await browser.newPage();
});
test.afterAll(async () => page.close());

test("reset environment and capture the first-run setup shot", async () => {
  resetEnv();
  seedSources();

  // The pre-login page has no theme toggle and index.html hardcodes dark.
  await page.goto("/");
  await page.getByText("Create your admin account").waitFor();
  await page.fill("#username", "admin");
  await page.fill("#password", "hunter22hunter22");
  await page.fill("#confirm", "hunter22hunter22");
  await page.screenshot({ path: path.join(RAW_DIR, "setup-dark.png") });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(RAW_DIR, "setup-light.png") });
  await page.evaluate(() => document.documentElement.classList.add("dark"));

  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("link", { name: "Dashboard" }).waitFor();
  api = await apiClient(page);
});

test("create repositories and plans", async () => {
  // Local repo through the UI (auto-init on).
  await page.getByRole("link", { name: "Repositories" }).click();
  await page.getByRole("button", { name: "Add repository" }).click();
  await page.fill("#name", REPO_LOCAL.name);
  await page.fill("#path", REPO_LOCAL.path);
  await page.fill("#password", REPO_LOCAL.password);
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "Add repository" }).waitFor({ timeout: 60_000 });

  // S3 repo on MinIO.
  await page.getByRole("button", { name: "Add repository" }).click();
  await page.fill("#name", REPO_S3.name);
  await page.selectOption("#backendType", "s3");
  await page.fill("#endpoint", "minio:9000");
  await page.fill("#bucket", "backups");
  await page.fill("#accessKeyId", "minioadmin");
  await page.fill("#secretAccessKey", "minioadmin123");
  await page.check('input[name="useHttp"]');
  await page.fill("#password", REPO_S3.password);
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "Add repository" }).waitFor({ timeout: 60_000 });

  // Plans via API (retention comes later — see file header).
  const base = { excludes: [], tags: [], retention: {}, options: {}, enabled: true, notifyMuted: false };
  planIds.docs = (
    await api.post("/api/plans", {
      ...base,
      name: PLAN_DOCS,
      repoId: 1,
      sources: ["/sources/docs"],
      excludes: ["*.tmp"],
      tags: ["nightly"],
      scheduleCron: "0 2 * * *",
    })
  ).id;
  planIds.photos = (
    await api.post("/api/plans", {
      ...base,
      name: PLAN_PHOTOS,
      repoId: 2,
      sources: ["/sources/photos"],
      tags: ["photos"],
      scheduleCron: "0 3 * * 0",
    })
  ).id;
  planIds.media = (
    await api.post("/api/plans", {
      ...base,
      name: PLAN_MEDIA,
      repoId: 2,
      sources: ["/sources/media"],
      tags: ["media"],
      scheduleCron: "",
      options: { uploadLimitKiB: 8192 },
    })
  ).id;
});

test("run the backup timeline", async () => {
  let docsRun = 0;
  let photosRun = 0;
  for (const [i, b] of TIMELINE.entries()) {
    if (b.plan === "docs") mutateDocs(++docsRun);
    if (b.plan === "photos") mutatePhotos(++photosRun);
    if (i === WARNING_INDEX) makeUnreadable("docs/id_rsa");

    const repoId = b.plan === "docs" ? 1 : 2;
    const { opId, status } = await runPlanAndWait(api, planIds[b.plan]);
    b.opId = opId;
    b.snapshotId = await latestSnapshotId(api, repoId);

    if (i === WARNING_INDEX) {
      expect(status).toBe("warning");
      removeUnreadable("docs/id_rsa");
    } else {
      expect(status).toBe("success");
    }
    console.log(`  op ${opId} (${b.plan}) → ${status}, snapshot ${b.snapshotId!.slice(0, 8)}`);
  }
});

test("check schedule, one real check run, notification settings", async () => {
  await api.post("/api/repos/1/check-schedule", { checkScheduleCron: "0 3 * * 0" });
  await api.post("/api/repos/1/check");
  // The check is op 19; poll it to completion so it's terminal before restart.
  const deadline = Date.now() + 120_000;
  for (;;) {
    const op = await api.get(`/api/operations/${TIMELINE.length + 1}`);
    if (op.status === "success") break;
    if (["error", "canceled", "warning"].includes(op.status)) throw new Error(`check ended ${op.status}`);
    if (Date.now() > deadline) throw new Error("check did not finish");
    await new Promise((r) => setTimeout(r, 500));
  }
  await api.put("/api/settings", {
    appriseApiUrl: "http://apprise:8000",
    appriseUrls: "ntfys://ntfy.sh/homelab-backups\ndiscord://81234567890/aBcDeFgHiJ",
    notifyOnSuccess: true,
    notifyOnFailure: true,
  });
});

test("backdate snapshots and database history", async () => {
  expect(resticLocal("rewrite --help")).toContain("--new-time");

  // Re-time every snapshot in place (new snapshot ids are fine — the DB
  // never stores them anywhere the UI reads).
  for (const b of TIMELINE) {
    rewriteSnapshotTime(b.plan === "docs" ? "local" : "s3", b.snapshotId!, resticTime(b.target));
  }

  // Fetch real op timings while the API is still up, then shift them in SQL
  // with the app stopped (single WAL connection).
  const stmts: string[] = [];
  for (const b of TIMELINE) {
    const op = await api.get(`/api/operations/${b.opId}`);
    stmts.push(backdateOpSql(b.opId!, op.startedAt, op.endedAt, b.target));
  }
  compose("stop app");
  runSql(stmts.join("\n"));
  compose("up -d --wait app");
});

test("add retention policies and sanity-check the dashboard", async () => {
  const docs = await api.get(`/api/plans/${planIds.docs}`);
  await api.put(`/api/plans/${planIds.docs}`, {
    ...docs,
    retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, prune: true },
  });
  const photos = await api.get(`/api/plans/${planIds.photos}`);
  await api.put(`/api/plans/${planIds.photos}`, {
    ...photos,
    retention: { keepWeekly: 8, prune: true },
  });

  const dash = await api.get("/api/dashboard");
  for (const p of dash.plans) {
    expect(p.overdue, `plan ${p.name} must not be overdue`).toBeFalsy();
  }
  expect(dash.repoGrowth.length).toBe(2);
  expect(dash.issues24h).toBe(0);
  console.log("staged: dashboard is green, growth series for both repos present");
});
