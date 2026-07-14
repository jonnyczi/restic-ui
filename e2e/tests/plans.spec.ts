import { test, expect, type Page } from "@playwright/test";
import { createLocalRepo, resetEnv, resticInContainer, setupAdmin, waitOpStatus } from "../helpers";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  resetEnv();
  page = await browser.newPage();
  await setupAdmin(page);
  await createLocalRepo(page, "main-repo", "/repos/main");
});
test.afterAll(async () => page.close());

test("create a plan via the directory browser", async () => {
  await page.getByRole("link", { name: "Plans" }).click();
  await page.getByText("No backup plans yet").waitFor();
  await page.getByRole("button", { name: "Add plan" }).click();
  await page.fill("#name", "docs-nightly");

  // Navigate the folder picker: / -> sources -> docs.
  await page.getByRole("button", { name: "Browse" }).click();
  const dirs = page.getByTestId("dir-browser");
  await dirs.getByRole("button", { name: "sources", exact: true }).click();
  await dirs.getByRole("button", { name: "docs", exact: true }).click();
  await dirs.getByRole("button", { name: "Select this folder" }).click();

  await page.fill("#exclude", "*.tmp");
  await page.getByRole("button", { name: "Add" }).nth(1).click();
  await page.fill("#tag", "nightly");
  await page.getByRole("button", { name: "Add" }).nth(2).click();
  await page.selectOption("#schedule", "0 2 * * *");

  await page.getByRole("button", { name: "Create plan" }).click();
  await page.getByRole("button", { name: "Add plan" }).waitFor();
  await page.getByTestId("plan-docs-nightly").waitFor();
});

test("plan card shows the schedule and next run", async () => {
  const card = page.getByTestId("plan-docs-nightly");
  // Humanized text is shown; the raw cron expression is preserved as its tooltip.
  await expect(card.getByText("Daily at 02:00")).toBeVisible();
  await expect(card.getByText("Daily at 02:00")).toHaveAttribute("title", "0 2 * * *");
  await expect(card.getByText(/next:/)).toBeVisible();
});

test("run now → operation succeeds live over the websocket", async () => {
  const card = page.getByTestId("plan-docs-nightly");
  await card.getByRole("button", { name: "Run now" }).click();
  await card.getByText("Backup started").waitFor();

  await page.getByRole("link", { name: "Operations", exact: true }).click();
  await page.getByTestId("op-row-1").click(); // expand to watch logs
  // Status must flip to success without a reload (websocket-driven).
  await waitOpStatus(page, 1, "success");
});

test("operation logs contain the snapshot summary", async () => {
  const logs = page.getByTestId("op-logs");
  await expect(logs.getByText(/Snapshot [0-9a-f]{8} saved/)).toBeVisible();
  await expect(logs.getByText("completed successfully")).toBeVisible();
});

test("a second run produces a second snapshot", async () => {
  await page.getByRole("link", { name: "Plans" }).click();
  const card = page.getByTestId("plan-docs-nightly");
  await card.getByRole("button", { name: "Run now" }).click();
  await card.getByText("Backup started").waitFor();

  await page.getByRole("link", { name: "Operations", exact: true }).click();
  await waitOpStatus(page, 2, "success");

  await page.getByRole("link", { name: "Repositories" }).click();
  const repo = page.getByTestId("repo-main-repo");
  await repo.getByRole("button", { name: "Snapshots" }).click();
  await expect(repo.locator("tbody tr")).toHaveCount(2, { timeout: 30_000 });
});

test("excluded files are not in the snapshot (restic CLI cross-check)", async () => {
  const ls = resticInContainer("/repos/main", "pass-main-repo", "ls latest");
  expect(ls).toContain("/sources/docs/a.txt");
  expect(ls).toContain("/sources/docs/big.bin");
  expect(ls).not.toContain("skip.tmp");
});

test("a dry-run previews the backup without creating a snapshot", async () => {
  await page.getByRole("link", { name: "Plans" }).click();
  const card = page.getByTestId("plan-docs-nightly");
  await card.getByRole("button", { name: "Edit plan" }).click();

  await page.getByRole("button", { name: "Dry-run this backup" }).click();
  const result = page.getByTestId("dry-run-result");
  await result.waitFor({ timeout: 60_000 });
  await expect(result.getByText(/Would add/)).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();
  // Still exactly two snapshots — the dry run wrote nothing.
  const snaps = resticInContainer("/repos/main", "pass-main-repo", "snapshots --compact");
  expect(snaps).toContain("2 snapshots");
});

test("backup options persist through an edit round-trip", async () => {
  const card = page.getByTestId("plan-docs-nightly");
  await card.getByRole("button", { name: "Edit plan" }).click();

  await page.fill("#uploadLimit", "512");
  const cachesBox = page.getByText("Skip cache dirs (CACHEDIR.TAG)").locator("input");
  await cachesBox.click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: "Add plan" }).waitFor();

  await card.getByRole("button", { name: "Edit plan" }).click();
  await expect(page.locator("#uploadLimit")).toHaveValue("512");
  await expect(page.getByText("Skip cache dirs (CACHEDIR.TAG)").locator("input")).toBeChecked();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("an every-minute cron plan fires by itself", async () => {
  test.setTimeout(240_000); // waits out a cron minute boundary

  await page.getByRole("link", { name: "Plans" }).click();
  await page.getByRole("button", { name: "Add plan" }).click();
  await page.fill("#name", "cron-test");
  await page.getByTestId("source-input").fill("/sources/photos");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await page.selectOption("#schedule", "custom");
  await page.fill("#customCron", "* * * * *");
  await page.getByRole("button", { name: "Create plan" }).click();
  await page.getByRole("button", { name: "Add plan" }).waitFor();

  await page.getByRole("link", { name: "Operations", exact: true }).click();
  await page.getByTestId("op-row-3").waitFor({ timeout: 75_000 });
  await expect(page.getByTestId("op-row-3").getByText("cron-test")).toBeVisible();
  await waitOpStatus(page, 3, "success");

  // Disable it so it stops firing while later specs run. The checkbox is a
  // controlled input that flips only after the server confirms, so click and
  // wait rather than uncheck() (whose immediate assertion would race it).
  await page.getByRole("link", { name: "Plans" }).click();
  const enabled = page.getByTestId("plan-cron-test").locator('input[type="checkbox"]');
  await enabled.click();
  await expect(enabled).not.toBeChecked();
});
