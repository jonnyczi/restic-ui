import { existsSync, readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { resetEnv, setupAdmin, testenvPath, waitOpStatus } from "../helpers";

// Regression coverage for SFTP repositories: the container user has no home
// directory, so ssh known_hosts and the restic cache must land under
// DATA_DIR (/config) — browsing a snapshot used to fail with
// "Could not create directory '/home/abc/.ssh'" + "unable to open cache".
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  resetEnv();
  page = await browser.newPage();
  await setupAdmin(page);
});
test.afterAll(async () => page.close());

test("create + auto-init an SFTP repository (key auth, TOFU host key)", async () => {
  await page.getByRole("link", { name: "Repositories" }).click();
  await page.getByRole("button", { name: "Add repository" }).click();
  await page.fill("#name", "sftp-test");
  await page.selectOption("#backendType", "sftp");
  await page.fill("#host", "sftp");
  await page.fill("#user", "backup");
  await page.fill("#path", "upload/restic");
  await page.fill("#privateKey", readFileSync(testenvPath("sshkeys", "id_ed25519"), "utf8"));
  await page.fill("#password", "pass-sftp-test");
  // Auto-init makes this the first connection — the accept-new host key
  // write that used to fail without a writable known_hosts location.
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "Add repository" }).waitFor({ timeout: 60_000 });
  await page.getByTestId("repo-sftp-test").waitFor();
});

test("connection test reports OK", async () => {
  const card = page.getByTestId("repo-sftp-test");
  await card.getByRole("button", { name: "Test" }).click();
  await card.getByText("Connection OK").waitFor();
});

test("backup to the SFTP repository succeeds", async () => {
  await page.getByRole("link", { name: "Plans" }).click();
  await page.getByRole("button", { name: "Add plan" }).click();
  await page.fill("#name", "sftp-docs");
  await page.getByTestId("source-input").fill("/sources/docs");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await page.getByRole("button", { name: "Create plan" }).click();
  await page.getByRole("button", { name: "Add plan" }).waitFor();

  const card = page.getByTestId("plan-sftp-docs");
  await card.getByRole("button", { name: "Run now" }).click();
  await card.getByText("Backup started").waitFor();
  await page.getByRole("link", { name: "Operations" }).click();
  await waitOpStatus(page, 1, "success", 120_000);
});

test("browse snapshot contents (the flow that failed before the fix)", async () => {
  await page.getByRole("link", { name: "Repositories" }).click();
  const repo = page.getByTestId("repo-sftp-test");
  await repo.getByRole("button", { name: "Snapshots" }).click();
  await expect(repo.locator("tbody tr")).toHaveCount(1, { timeout: 30_000 });

  await repo.locator("tbody tr").first().click();
  const sb = page.getByTestId("snapshot-browser");
  await sb.waitFor();
  await sb.getByRole("button", { name: "sources", exact: true }).click();
  await sb.getByRole("button", { name: "docs", exact: true }).click();
  await expect(sb.getByText("a.txt")).toBeVisible();
});

test("host key and restic cache persisted under /config", async () => {
  const knownHosts = readFileSync(testenvPath("config", "ssh", "known_hosts"), "utf8");
  expect(knownHosts).toContain("sftp");
  expect(existsSync(testenvPath("config", "cache"))).toBe(true);
});

test("forget the SFTP snapshot via inline confirm", async () => {
  const repo = page.getByTestId("repo-sftp-test");
  await repo.getByRole("button", { name: /Forget snapshot/ }).click();
  await repo.getByText("Forget? Data kept until prune.").waitFor();
  await repo.getByRole("button", { name: "Forget", exact: true }).click();
  await repo.getByText("Forget started").waitFor();

  await page.getByRole("link", { name: "Operations" }).click();
  await waitOpStatus(page, 2, "success");
  // The snapshots panel is component-local state — re-expand after navigation.
  await page.getByRole("link", { name: "Repositories" }).click();
  await repo.getByRole("button", { name: "Snapshots" }).click();
  await repo.getByText("No snapshots yet.").waitFor({ timeout: 30_000 });
});
