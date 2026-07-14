import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { createLocalRepo, resetEnv, setupAdmin, waitOpStatus } from "../helpers";

test.describe.configure({ mode: "serial" });

const PAGES: Array<[path: string, heading: string]> = [
  ["/", "Dashboard"],
  ["/repos", "Repositories"],
  ["/plans", "Backup plans"],
  ["/operations", "Operations"],
  ["/settings", "Settings"],
];

// 360 = smallest supported phone; 768 = exactly the md breakpoint (desktop layout).
const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 768, height: 1024 },
];

let page: Page;

/** Pixels the page overflows the viewport horizontally (0 = fits). */
const hOverflow = () =>
  page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );

test.beforeAll(async ({ browser }) => {
  resetEnv();
  // Seed at the default desktop viewport — the helpers click nav links that
  // are hidden behind the hamburger below md.
  page = await browser.newPage();
  await setupAdmin(page);
  await createLocalRepo(page, "main-repo", "/repos/main");

  // Manual-only plan without retention → running it yields exactly op #1.
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
});
test.afterAll(async () => page.close());

for (const vp of VIEWPORTS) {
  test(`no horizontal overflow on any page at ${vp.width}px`, async () => {
    await page.setViewportSize(vp);
    for (const [path, heading] of PAGES) {
      await page.goto(path);
      await page.getByRole("heading", { name: heading }).waitFor();
      expect(await hOverflow(), `${path} overflows at ${vp.width}px`).toBe(0);
      await page.screenshot({
        path: `test-results/responsive-${vp.width}-${heading.replace(/\s/g, "_")}.png`,
        fullPage: true,
      });
    }
  });
}

test("deep content fits at 360px (snapshots, browser, expanded op)", async () => {
  await page.setViewportSize({ width: 360, height: 740 });

  await page.goto("/repos");
  const repo = page.getByTestId("repo-main-repo");
  await repo.getByRole("button", { name: "Snapshots" }).click();
  await repo.locator("tbody tr").first().waitFor();
  expect(await hOverflow(), "snapshot table overflows").toBe(0);

  // Find results (mono paths) must not widen the page either.
  await repo.getByLabel("Find file pattern").fill("a.txt");
  await repo.getByRole("button", { name: "Find", exact: true }).click();
  await repo.getByTestId("find-results").waitFor({ timeout: 60_000 });
  expect(await hOverflow(), "find results overflow").toBe(0);

  // Browse the snapshot down to real file rows (name/size/actions columns).
  await repo.locator("tbody tr").first().click(); // toggles the snapshot browser
  const sb = page.getByTestId("snapshot-browser");
  await sb.waitFor();
  await sb.getByRole("button", { name: "sources", exact: true }).click();
  await sb.getByRole("button", { name: "docs", exact: true }).click();
  await expect(sb.getByText("big.bin")).toBeVisible();
  expect(await hOverflow(), "snapshot browser overflows").toBe(0);
  await page.screenshot({
    path: "test-results/responsive-360-snapshot-browser.png",
    fullPage: true,
  });

  // Downloading a file works from the mobile layout.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    sb.getByRole("button", { name: "Download a.txt" }).click(),
  ]);
  expect(readFileSync((await download.path())!, "utf8")).toContain("hello world");

  await page.goto("/operations");
  await page.getByTestId("op-row-1").click(); // expand logs
  await page.getByTestId("op-logs").waitFor();
  expect(await hOverflow(), "expanded operation overflows").toBe(0);
  await page.screenshot({ path: "test-results/responsive-360-op-detail.png", fullPage: true });
});

test("hamburger menu toggles, navigates, and closes at 360px", async () => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");

  const burger = page.getByRole("button", { name: "Toggle navigation" });
  await expect(burger).toBeVisible();
  await expect(page.getByTestId("mobile-nav")).toHaveCount(0); // closed = not in the DOM

  await burger.click();
  await expect(burger).toHaveAttribute("aria-expanded", "true");
  await page.getByTestId("mobile-nav").getByRole("link", { name: "Repositories" }).click();
  await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
  await expect(page.getByTestId("mobile-nav")).toHaveCount(0); // closes after navigating
  expect(await hOverflow()).toBe(0);
});

test("desktop nav replaces the hamburger at 768px", async () => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeHidden();
  await expect(page.getByRole("link", { name: "Repositories" })).toBeVisible();
});
