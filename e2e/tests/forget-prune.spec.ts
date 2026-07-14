import { test, expect, type Page } from "@playwright/test";
import {
  createLocalRepo,
  resetEnv,
  resticInContainer,
  setupAdmin,
  waitOpStatus,
} from "../helpers";

// Per-snapshot forget and repo-level prune, both behind inline confirms.
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  resetEnv();
  page = await browser.newPage();
  await setupAdmin(page);
  await createLocalRepo(page, "fp-repo", "/repos/fp");
});
test.afterAll(async () => page.close());

test("two backups produce two snapshots", async () => {
  // Plan without retention so operations stay numbered 1 and 2.
  await page.getByRole("link", { name: "Plans" }).click();
  await page.getByRole("button", { name: "Add plan" }).click();
  await page.fill("#name", "fp");
  await page.getByTestId("source-input").fill("/sources/docs");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await page.getByRole("button", { name: "Create plan" }).click();
  await page.getByRole("button", { name: "Add plan" }).waitFor();

  const card = page.getByTestId("plan-fp");
  for (const op of [1, 2]) {
    await card.getByRole("button", { name: "Run now" }).click();
    await card.getByText("Backup started").waitFor();
    await page.getByRole("link", { name: "Operations", exact: true }).click();
    await waitOpStatus(page, op, "success");
    await page.getByRole("link", { name: "Plans" }).click();
  }

  await page.getByRole("link", { name: "Repositories" }).click();
  const repo = page.getByTestId("repo-fp-repo");
  await repo.getByRole("button", { name: "Snapshots" }).click();
  await expect(repo.locator("tbody tr")).toHaveCount(2, { timeout: 30_000 });
});

test("cancelling the forget confirm keeps the snapshot", async () => {
  const repo = page.getByTestId("repo-fp-repo");
  await repo.getByRole("button", { name: /Forget snapshot/ }).first().click();
  await repo.getByText("Forget? Data kept until prune.").waitFor();
  await repo.getByRole("button", { name: "Cancel" }).click();
  await expect(repo.getByText("Forget? Data kept until prune.")).toBeHidden();
  await expect(repo.locator("tbody tr")).toHaveCount(2);
});

test("forget removes the snapshot after confirmation", async () => {
  const repo = page.getByTestId("repo-fp-repo");
  await repo.getByRole("button", { name: /Forget snapshot/ }).first().click();
  await repo.getByRole("button", { name: "Forget", exact: true }).click();
  await repo.getByText("Forget started").waitFor();

  await page.getByRole("link", { name: "Operations", exact: true }).click();
  await waitOpStatus(page, 3, "success");
  await expect(page.getByTestId("op-row-3").getByText("forget")).toBeVisible();

  // The snapshots panel is component-local state — re-expand after
  // navigation (the query cache itself is already invalidated by the
  // event stream, so the reopened list is fresh without a manual refetch).
  await page.getByRole("link", { name: "Repositories" }).click();
  await repo.getByRole("button", { name: "Snapshots" }).click();
  await expect(repo.locator("tbody tr")).toHaveCount(1, { timeout: 30_000 });
  expect(resticInContainer("/repos/fp", "pass-fp-repo", "snapshots --compact")).toContain(
    "1 snapshots",
  );
});

test("prune runs after inline confirmation", async () => {
  const repo = page.getByTestId("repo-fp-repo");
  await repo.getByRole("button", { name: "Prune" }).click();
  await repo.getByText("Delete unreferenced data?").waitFor();
  await repo.getByRole("button", { name: "Prune", exact: true }).click();
  await repo.getByText("Prune started").waitFor();

  await page.getByRole("link", { name: "Operations", exact: true }).click();
  await waitOpStatus(page, 4, "success", 120_000);
  await expect(page.getByTestId("op-row-4").getByText("prune")).toBeVisible();
  await page.getByTestId("op-row-4").click();
  await expect(page.getByTestId("op-logs")).toBeVisible();
});
