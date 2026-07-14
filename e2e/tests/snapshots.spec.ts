import { appendFileSync, writeFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import {
  createLocalRepo,
  resetEnv,
  setupAdmin,
  testenvPath,
  waitOpStatus,
} from "../helpers";

// Snapshot diff and find-file-across-snapshots.
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  resetEnv();
  page = await browser.newPage();
  await setupAdmin(page);
  await createLocalRepo(page, "main-repo", "/repos/main");

  // Manual-only plan; two backups with a source mutation in between so the
  // snapshots genuinely differ.
  await page.getByRole("link", { name: "Plans" }).click();
  await page.getByRole("button", { name: "Add plan" }).click();
  await page.fill("#name", "docs");
  await page.getByTestId("source-input").fill("/sources/docs");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await page.getByRole("button", { name: "Create plan" }).click();
  await page.getByRole("button", { name: "Add plan" }).waitFor();

  const card = page.getByTestId("plan-docs");
  await card.getByRole("button", { name: "Run now" }).click();
  await card.getByText("Backup started").waitFor();
  await page.getByRole("link", { name: "Operations", exact: true }).click();
  await waitOpStatus(page, 1, "success");

  // Mutate the sources on the host (the container mount is read-only).
  appendFileSync(testenvPath("sources", "docs", "a.txt"), "\nchanged for diff\n");
  writeFileSync(testenvPath("sources", "docs", "added.txt"), "brand new file\n");

  await page.getByRole("link", { name: "Plans" }).click();
  await card.getByRole("button", { name: "Run now" }).click();
  await card.getByText("Backup started").waitFor();
  await page.getByRole("link", { name: "Operations", exact: true }).click();
  await waitOpStatus(page, 2, "success");
});
test.afterAll(async () => page.close());

test("diff two snapshots lists changed and added paths", async () => {
  await page.getByRole("link", { name: "Repositories" }).click();
  const repo = page.getByTestId("repo-main-repo");
  await repo.getByRole("button", { name: "Snapshots" }).click();
  await expect(repo.locator("tbody tr")).toHaveCount(2, { timeout: 30_000 });

  // Compare defaults to older → newer; just run it.
  await repo.getByRole("button", { name: "Diff", exact: true }).click();
  const results = repo.getByTestId("diff-results");
  await results.waitFor({ timeout: 60_000 });
  await expect(results.getByText(/changed file/)).toBeVisible();
  await expect(results.getByText("/sources/docs/a.txt")).toBeVisible();
  await expect(results.getByText("/sources/docs/added.txt")).toBeVisible();
});

test("find locates a file across snapshots", async () => {
  const repo = page.getByTestId("repo-main-repo");
  await repo.getByLabel("Find file pattern").fill("a.txt");
  await repo.getByRole("button", { name: "Find", exact: true }).click();
  const results = repo.getByTestId("find-results");
  await results.waitFor({ timeout: 60_000 });
  // a.txt exists in both snapshots → two groups, each listing the path.
  await expect(results.getByText("/sources/docs/a.txt").first()).toBeVisible();
  await expect(results.getByText(/1 hit/).first()).toBeVisible();
});

test("find with no matches says so", async () => {
  const repo = page.getByTestId("repo-main-repo");
  await repo.getByLabel("Find file pattern").fill("does-not-exist-xyz");
  await repo.getByRole("button", { name: "Find", exact: true }).click();
  await repo.getByTestId("find-results").getByText("No matches.").waitFor({ timeout: 60_000 });
});
