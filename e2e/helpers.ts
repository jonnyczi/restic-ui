import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";

export const PASSWORD = "hunter22hunter22";

/** Root of the e2e directory (where the compose file lives). */
export const E2E_DIR = __dirname;

/** Host path of a file inside the test environment volumes. */
export const testenvPath = (...parts: string[]) =>
  path.join(E2E_DIR, ".testenv", ...parts);

const compose = (args: string) =>
  execSync(`docker compose -f docker-compose.test.yml ${args}`, {
    cwd: E2E_DIR,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();

/** Reset volumes + containers to a pristine, seeded state. */
export function resetEnv() {
  execSync("bash ./reset-env.sh", { cwd: E2E_DIR, stdio: "inherit" });
}

/** Restart the app container and wait for it to come back healthy. */
export function restartApp() {
  compose("restart app");
  compose("up -d --wait app");
}

/** Logs of the fake Apprise server (assert on NOTIFY lines). */
export function appriseLogs(): string {
  return compose("logs apprise");
}

/** Run restic inside the app container against a local test repo. */
export function resticInContainer(repoPath: string, password: string, args: string): string {
  return compose(
    `exec -T -e RESTIC_REPOSITORY=${repoPath} -e RESTIC_PASSWORD=${password} app restic ${args}`,
  );
}

/** Complete the first-run setup form (expects a fresh environment). */
export async function setupAdmin(page: Page) {
  await page.goto("/");
  await page.getByText("Create your admin account").waitFor();
  await page.fill("#username", "admin");
  await page.fill("#password", PASSWORD);
  await page.fill("#confirm", PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("link", { name: "Dashboard" }).waitFor();
}

/** Log in with the standard test credentials. */
export async function login(page: Page) {
  await page.goto("/");
  await page.getByText("Sign in to manage your backups").waitFor();
  await page.fill("#username", "admin");
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Dashboard" }).waitFor();
}

/** Create a local-path repository through the UI (auto-init on). */
export async function createLocalRepo(page: Page, name: string, repoPath: string) {
  await page.getByRole("link", { name: "Repositories" }).click();
  await page.getByRole("button", { name: "Add repository" }).click();
  await page.fill("#name", name);
  await page.fill("#path", repoPath);
  await page.fill("#password", `pass-${name}`);
  await page.getByRole("button", { name: "Create" }).click();
  // Form closes (button returns) once create + init complete.
  await page.getByRole("button", { name: "Add repository" }).waitFor({ timeout: 60_000 });
  await page.getByTestId(`repo-${name}`).waitFor();
}

/** Wait until an operation row shows a given status. */
export async function waitOpStatus(
  page: Page,
  rowId: number,
  status: string,
  timeout = 90_000,
) {
  await page
    .getByTestId(`op-row-${rowId}`)
    .getByText(status, { exact: false })
    .waitFor({ timeout });
}
