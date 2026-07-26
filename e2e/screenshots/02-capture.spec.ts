import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { login } from "../helpers";
import {
  appendSource,
  PLAN_DOCS,
  PLAN_MEDIA,
  randomFile,
  RAW_DIR,
  REPO_LOCAL,
  writeSource,
} from "./stage-helpers";

// Captures every README screenshot (except "setup", taken during staging)
// against the environment prepared by 01-stage.spec.ts. Each shot is taken
// in dark mode, the in-place theme toggle is clicked (preserving expanded
// panels/dialogs), the light variant is taken, and the toggle is restored.
// The live-progress shot runs last because it mutates repo stats.

test.describe.configure({ mode: "serial" });

let page: Page;

const raw = (name: string) => path.join(RAW_DIR, name);

async function dismissToasts(p: Page) {
  for (const dismiss of await p.getByTestId("toast").getByRole("button", { name: "Dismiss" }).all()) {
    await dismiss.click().catch(() => {});
  }
}

/** Take dark + light variants of one shot; `take` performs the capture. */
async function shoot(slug: string, take: (file: string) => Promise<void>) {
  await dismissToasts(page);
  await take(raw(`${slug}-dark.png`));
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await page.waitForTimeout(250);
  await take(raw(`${slug}-light.png`));
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page.waitForTimeout(250);
}

/**
 * Screenshot a vertical slice of the page: full width of `frame`, from the
 * top of `top` to the bottom of `bottom`. Locator boxes are viewport-relative,
 * so add the scroll offset and capture from the full page.
 */
async function clipShot(file: string, frame: Locator, top: Locator, bottom: Locator, pad = 12) {
  const fb = (await frame.boundingBox())!;
  const tb = (await top.boundingBox())!;
  const bb = (await bottom.boundingBox())!;
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  await page.screenshot({
    path: file,
    fullPage: true,
    clip: {
      x: fb.x + scroll.x,
      y: tb.y + scroll.y - pad,
      width: fb.width,
      height: bb.y + bb.height - tb.y + 2 * pad,
    },
  });
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(RAW_DIR, { recursive: true });
  const context = await browser.newContext();
  // Every navigation starts in dark mode regardless of earlier toggling.
  await context.addInitScript(() => localStorage.setItem("theme", "dark"));
  page = await context.newPage();
  await login(page);
});
test.afterAll(async () => page.close());

test("dashboard (hero)", async () => {
  await page.goto("/");
  await expect(page.getByTestId("repo-growth")).toBeVisible();
  await expect(page.getByText("Recent activity")).toBeVisible();
  await shoot("dashboard", (f) => page.screenshot({ path: f }));
});

test("plans page", async () => {
  await page.goto("/plans");
  await expect(page.getByTestId(`plan-${PLAN_DOCS}`)).toBeVisible();
  await shoot("plans", (f) => page.screenshot({ path: f }));
});

test("add-plan form with folder picker", async () => {
  await page.getByRole("button", { name: "Add plan" }).click();
  await page.fill("#name", "Appdata");
  await page.getByRole("button", { name: "Browse" }).click();
  const picker = page.getByTestId("dir-browser");
  await picker.getByRole("button", { name: "sources" }).click();
  await expect(picker.getByRole("button", { name: "docs" })).toBeVisible();
  await page.selectOption("#schedule", "0 2 * * *");

  const card = page.locator("div.bg-card").filter({ hasText: "Add backup plan" });
  const schedule = page.locator("#schedule");
  await shoot("add-plan", (f) => clipShot(f, card, card, schedule, 16));
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("plan edit: dry-run preview", async () => {
  // Pending source changes so the dry-run has something to report.
  writeSource("docs/projects/q3-budget-draft.ods", "draft");
  randomFile("docs/archive/scan-15.pdf", 480 * 1024);
  appendSource("docs/notes/worklog.md", "\n## Entry 15\n- scanned receipts\n");

  await page.goto("/plans");
  await page.getByTestId(`plan-${PLAN_DOCS}`).getByRole("button", { name: "Edit plan" }).click();
  await expect(page.getByText(`Edit plan: ${PLAN_DOCS}`)).toBeVisible();
  await page.getByRole("button", { name: "Dry-run this backup" }).click();
  await expect(page.getByTestId("dry-run-result")).toBeVisible({ timeout: 60_000 });

  const options = page.locator("div.rounded-md.border").filter({ hasText: "Backup options" }).first();
  await options.scrollIntoViewIfNeeded();
  await shoot("plan-dry-run", (f) => options.screenshot({ path: f }));
});

test("plan edit: retention preview", async () => {
  await page.getByRole("button", { name: "Preview what this would keep" }).click();
  await expect(page.getByText(/Would keep/)).toBeVisible({ timeout: 60_000 });

  const retention = page
    .locator("div.rounded-md.border")
    .filter({ hasText: "Retention — how many snapshots" })
    .first();
  await retention.scrollIntoViewIfNeeded();
  await shoot("plan-retention", (f) => retention.screenshot({ path: f }));
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("repositories with snapshots panel", async () => {
  await page.goto("/repos");
  const repo = page.getByTestId(`repo-${REPO_LOCAL.name}`);
  await repo.getByRole("button", { name: "Snapshots" }).click();
  await expect(repo.locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });
  await expect(repo.getByTestId("repo-size-trend")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot("repos", (f) => page.screenshot({ path: f }));
});

test("find a file across snapshots", async () => {
  const repo = page.getByTestId(`repo-${REPO_LOCAL.name}`);
  await repo.getByLabel("Find file pattern").fill("tax-return*");
  await repo.getByRole("button", { name: "Find" }).click();
  await expect(repo.getByTestId("find-results")).toBeVisible({ timeout: 60_000 });

  const findForm = repo.getByLabel("Find file pattern");
  await findForm.scrollIntoViewIfNeeded();
  // Tight padding: the stats sparkline sits directly above the find form and
  // the snapshot table directly below the results.
  await shoot("snapshot-find", (f) => clipShot(f, repo, findForm, repo.getByTestId("find-results"), 4));
});

test("snapshot browser with restore dialog", async () => {
  const repo = page.getByTestId(`repo-${REPO_LOCAL.name}`);
  await repo.locator("tbody tr").first().click();
  const sb = page.getByTestId("snapshot-browser");
  await sb.waitFor();
  await sb.getByRole("button", { name: "sources", exact: true }).click();
  await sb.getByRole("button", { name: "docs", exact: true }).click();
  await expect(sb.getByText("projects")).toBeVisible();
  await sb.getByRole("button", { name: "Restore projects" }).click();
  await expect(sb.getByRole("button", { name: "Restore", exact: true })).toBeVisible();

  await sb.scrollIntoViewIfNeeded();
  await shoot("snapshot-browser", (f) => sb.screenshot({ path: f }));
  await sb.getByRole("button", { name: "Close browser" }).click();
});

test("diff two snapshots", async () => {
  const repo = page.getByTestId(`repo-${REPO_LOCAL.name}`);
  await repo.getByRole("button", { name: "Diff", exact: true }).click();
  await expect(repo.getByTestId("diff-results")).toBeVisible({ timeout: 60_000 });

  const from = repo.getByLabel("Diff from snapshot");
  await from.scrollIntoViewIfNeeded();
  await shoot("snapshot-diff", (f) => clipShot(f, repo, from, repo.getByTestId("diff-results")));
});

test("add-repository form (S3 example)", async () => {
  await page.goto("/repos");
  await page.getByRole("button", { name: "Add repository" }).click();
  await page.fill("#name", "backblaze-b2");
  await page.selectOption("#backendType", "s3");
  await page.fill("#endpoint", "s3.us-west-000.backblazeb2.com");
  await page.fill("#bucket", "homelab-backups");
  await page.fill("#region", "us-west-000");
  await page.fill("#accessKeyId", "000abc1234def0000000001");
  await page.fill("#secretAccessKey", "K000fakeFakeFAKEfakefakefakeZZZZ");
  await page.fill("#password", "correct-horse-battery-staple");

  const card = page.locator("div.bg-card").filter({ hasText: "Add repository" });
  await shoot("add-repo", (f) => card.screenshot({ path: f }));
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("operations history with expanded warning logs", async () => {
  await page.goto("/operations");
  const warningRow = page
    .locator("tr[data-testid^='op-row-']")
    .filter({ hasText: "warning" })
    .first();
  await warningRow.click();
  await expect(page.getByTestId("op-logs")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot("operations", (f) => page.screenshot({ path: f }));
});

test("settings: notifications", async () => {
  await page.goto("/settings");
  const card = page.locator("div.bg-card").filter({ hasText: "Notifications" });
  await expect(card.locator("#appriseApiUrl")).toHaveValue("http://apprise:8000");
  await shoot("settings", (f) => card.screenshot({ path: f }));
});

test("live backup progress (runs last — mutates stats)", async () => {
  // Fresh media so the throttled upload (8 MiB/s) gives a ~30 s window.
  randomFile("media/movies/family-trip-2024.mp4", 250 * 1024 * 1024);

  await page.goto("/plans");
  const card = page.getByTestId(`plan-${PLAN_MEDIA}`);
  await card.getByRole("button", { name: "Run now" }).click();
  await expect(card.getByTestId("op-progress")).toBeVisible({ timeout: 60_000 });
  // Let the progress bar advance past 0% before shooting.
  await page.waitForTimeout(4_000);
  await card.scrollIntoViewIfNeeded();
  await shoot("backup-live", (f) => card.screenshot({ path: f }));
});
