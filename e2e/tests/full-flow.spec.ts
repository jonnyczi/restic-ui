import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import {
  appriseLogs,
  createLocalRepo,
  resetEnv,
  resticInContainer,
  setupAdmin,
  testenvPath,
  waitOpStatus,
} from "../helpers";

// Retention chaining, snapshot browse/download/restore, copy to a second
// repository, notifications, and the dashboard.
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  resetEnv();
  page = await browser.newPage();
  await setupAdmin(page);
  await createLocalRepo(page, "main-repo", "/repos/main");
  await createLocalRepo(page, "second-repo", "/repos/second");
});
test.afterAll(async () => page.close());

test("create a plan with keep-last-1 retention + prune", async () => {
  await page.getByRole("link", { name: "Plans" }).click();
  await page.getByRole("button", { name: "Add plan" }).click();
  await page.fill("#name", "docs");
  await page.getByTestId("source-input").fill("/sources/docs");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await page.fill("#keepLast", "1");
  await page.getByRole("button", { name: "Create plan" }).click();
  await page.getByRole("button", { name: "Add plan" }).waitFor();
});

test("backup #1 chains an automatic retention operation", async () => {
  const card = page.getByTestId("plan-docs");
  await card.getByRole("button", { name: "Run now" }).click();
  await card.getByText("Backup started").waitFor();

  await page.getByRole("link", { name: "Operations" }).click();
  await waitOpStatus(page, 1, "success"); // backup
  await expect(page.getByTestId("op-row-2").getByText("retention")).toBeVisible({
    timeout: 15_000,
  });
  await waitOpStatus(page, 2, "success");
});

test("backup #2 → retention prunes down to a single snapshot", async () => {
  await page.getByRole("link", { name: "Plans" }).click();
  const card = page.getByTestId("plan-docs");
  await card.getByRole("button", { name: "Run now" }).click();
  await card.getByText("Backup started").waitFor();

  await page.getByRole("link", { name: "Operations" }).click();
  await waitOpStatus(page, 3, "success");
  await waitOpStatus(page, 4, "success", 120_000);

  await page.getByTestId("op-row-4").click();
  await expect(
    page.getByTestId("op-logs").getByText(/remove.*snapshot|removed/i).first(),
  ).toBeVisible();

  // UI and restic CLI agree: exactly one snapshot remains.
  await page.getByRole("link", { name: "Repositories" }).click();
  const repo = page.getByTestId("repo-main-repo");
  await repo.getByRole("button", { name: "Snapshots" }).click();
  await expect(repo.locator("tbody tr")).toHaveCount(1, { timeout: 30_000 });
  expect(resticInContainer("/repos/main", "pass-main-repo", "snapshots --compact")).toContain(
    "1 snapshots",
  );
});

test("browse the snapshot down to /sources/docs", async () => {
  const repo = page.getByTestId("repo-main-repo");
  await repo.locator("tbody tr").first().click();
  const sb = page.getByTestId("snapshot-browser");
  await sb.waitFor();
  await sb.getByRole("button", { name: "sources", exact: true }).click();
  await sb.getByRole("button", { name: "docs", exact: true }).click();
  await expect(sb.getByText("a.txt")).toBeVisible();
  await expect(sb.getByText("big.bin")).toBeVisible();
});

test("download a file and verify its content", async () => {
  const sb = page.getByTestId("snapshot-browser");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    sb.getByRole("button", { name: "Download a.txt" }).click(),
  ]);
  const content = readFileSync((await download.path())!, "utf8");
  expect(content).toContain("hello world");
});

test("restore a file to /restore and find it on disk", async () => {
  const sb = page.getByTestId("snapshot-browser");
  await sb.getByRole("button", { name: "Restore b.md" }).click();
  await sb.getByRole("button", { name: "Restore", exact: true }).click();
  await sb.getByText("Restore of b.md started").waitFor();

  await page.getByRole("link", { name: "Operations" }).click();
  await waitOpStatus(page, 5, "success");

  const restored = readFileSync(testenvPath("restore", "sources", "docs", "b.md"), "utf8");
  expect(restored).toContain("# notes");
});

test("copy snapshots to the second repository", async () => {
  await page.getByRole("link", { name: "Repositories" }).click();
  const repo = page.getByTestId("repo-main-repo");
  await repo.getByRole("button", { name: "Snapshots" }).click();
  await repo.locator("tbody tr").first().waitFor();
  await repo.getByLabel("Copy destination repository").selectOption({ label: "second-repo" });
  await repo.getByRole("button", { name: "Copy" }).click();
  await repo.getByText("Copy started").waitFor();

  await page.getByRole("link", { name: "Operations" }).click();
  await waitOpStatus(page, 6, "success", 120_000);

  const repo2 = page.getByTestId("repo-second-repo");
  await page.getByRole("link", { name: "Repositories" }).click();
  await repo2.getByRole("button", { name: "Snapshots" }).click();
  await expect(repo2.locator("tbody tr")).toHaveCount(1, { timeout: 30_000 });
});

test("configure notifications and send a test", async () => {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.fill("#appriseApiUrl", "http://apprise:8000");
  await page.locator('input[type="checkbox"]').nth(1).check(); // notify on success
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Settings saved.").waitFor();
  await page.getByRole("button", { name: "Send test notification" }).click();
  await page.getByText("Test notification sent").waitFor();
  expect(appriseLogs()).toContain("test notification");
});

test("a completed backup sends a notification", async () => {
  await page.getByRole("link", { name: "Plans" }).click();
  const card = page.getByTestId("plan-docs");
  await card.getByRole("button", { name: "Run now" }).click();
  await card.getByText("Backup started").waitFor();
  await page.getByRole("link", { name: "Operations" }).click();
  await waitOpStatus(page, 7, "success");

  await expect(async () => {
    expect(appriseLogs()).toContain('backup \\"docs\\" success');
  }).toPass({ timeout: 15_000 });
});

test("dashboard shows counts, plan status, and recent activity", async () => {
  await page.getByRole("link", { name: "Dashboard" }).click();
  await page.getByText("Your backups at a glance.").waitFor();
  await expect(page.getByText("Backup plans")).toBeVisible();
  await expect(page.getByText("Recent activity")).toBeVisible();
});
