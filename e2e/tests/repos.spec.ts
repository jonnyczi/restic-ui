import { readFileSync } from "node:fs";
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  PASSWORD,
  createLocalRepo,
  resetEnv,
  setupAdmin,
  testenvPath,
} from "../helpers";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  resetEnv();
  page = await browser.newPage();
  await setupAdmin(page);
});
test.afterAll(async () => page.close());

test("create + auto-init a local repository", async () => {
  await createLocalRepo(page, "local-test", "/repos/test1");
});

test("connection test reports OK", async () => {
  const card = page.getByTestId("repo-local-test");
  await card.getByRole("button", { name: "Test" }).click();
  await card.getByText("Connection OK").waitFor();
});

test("snapshots list is empty before any backup", async () => {
  const card = page.getByTestId("repo-local-test");
  await card.getByRole("button", { name: "Snapshots" }).click();
  await card.getByText("No snapshots yet.").waitFor();
});

test("integrity check passes", async () => {
  const card = page.getByTestId("repo-local-test");
  await card.getByRole("button", { name: "Check" }).click();
  await card.getByText("Integrity check passed.").waitFor({ timeout: 60_000 });
});

test("create an S3 repository against MinIO", async () => {
  await page.getByRole("button", { name: "Add repository" }).click();
  await page.fill("#name", "minio-s3");
  await page.selectOption("#backendType", "s3");
  await page.fill("#endpoint", "minio:9000");
  await page.fill("#bucket", "backups");
  await page.fill("#accessKeyId", "minioadmin");
  await page.fill("#secretAccessKey", "minioadmin123");
  await page.check('input[name="useHttp"]');
  await page.fill("#password", "repo-pass-s3");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "Add repository" }).waitFor({ timeout: 60_000 });

  const card = page.getByTestId("repo-minio-s3");
  await card.getByRole("button", { name: "Test" }).click();
  await card.getByText("Connection OK").waitFor();
});

test("uninitialized repo shows a friendly error", async () => {
  await page.getByRole("button", { name: "Add repository" }).click();
  await page.fill("#name", "not-initialized");
  await page.fill("#path", "/repos/does-not-exist");
  await page.fill("#password", "whatever-pass");
  await page.uncheck('input[type="checkbox"] >> nth=0'); // auto-init off
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "Add repository" }).waitFor();

  const card = page.getByTestId("repo-not-initialized");
  await card.getByRole("button", { name: "Test" }).click();
  await card.getByText(/does not exist|initialized/).waitFor();
});

test("secrets are not stored in plaintext", async () => {
  const db = readFileSync(testenvPath("config", "restic-ui.db"));
  for (const needle of ["minioadmin123", "repo-pass-s3", "pass-local-test"]) {
    expect(db.includes(Buffer.from(needle)), `found plaintext ${needle}`).toBe(false);
  }
});

test.describe("CSRF enforcement", () => {
  const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8199";
  let api: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    // A separate request context that logs in but never learns the CSRF token.
    api = await playwright.request.newContext({ baseURL: BASE });
    const res = await api.post("/api/auth/login", {
      data: { username: "admin", password: PASSWORD },
    });
    expect(res.ok()).toBe(true);
  });
  test.afterAll(async () => api.dispose());

  test("mutation without CSRF header is rejected", async () => {
    const res = await api.post("/api/repos/1/test");
    expect(res.status()).toBe(403);
  });

  test("mutation with wrong CSRF token is rejected", async () => {
    const res = await api.post("/api/repos/1/test", {
      headers: { "X-CSRF-Token": "wrong-token" },
    });
    expect(res.status()).toBe(403);
  });

  test("mutation with the session's CSRF token succeeds", async () => {
    const me = await (await api.get("/api/auth/me")).json();
    const res = await api.post("/api/repos/1/test", {
      headers: { "X-CSRF-Token": me.csrfToken },
    });
    expect(res.status()).toBe(200);
  });
});
