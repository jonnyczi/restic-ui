import { test, expect, type Page } from "@playwright/test";
import { PASSWORD, resetEnv, restartApp } from "../helpers";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  resetEnv();
  page = await browser.newPage();
});
test.afterAll(async () => page.close());

test("first-run setup rejects mismatched passwords", async () => {
  await page.goto("/");
  await page.getByText("Create your admin account").waitFor();
  await page.fill("#username", "admin");
  await page.fill("#password", PASSWORD);
  await page.fill("#confirm", "different");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toContainText("do not match");
});

test("valid setup logs straight in", async () => {
  await page.fill("#confirm", PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("current-user")).toHaveText("admin");
});

test("session survives a page reload", async () => {
  await page.reload();
  await expect(page.getByTestId("current-user")).toHaveText("admin");
});

test("logout returns to the login page", async () => {
  await page.getByRole("button", { name: "Log out" }).click();
  await page.getByText("Sign in to manage your backups").waitFor();
});

test("wrong password is rejected with a message", async () => {
  await page.fill("#username", "admin");
  await page.fill("#password", "wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("invalid username or password");
});

test("correct login reaches the app", async () => {
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("current-user")).toHaveText("admin");
});

test("session survives a container restart (persisted in SQLite)", async () => {
  restartApp();
  await page.reload();
  await expect(page.getByTestId("current-user")).toHaveText("admin");
});

test("unauthenticated API requests get 401", async ({ request }) => {
  const res = await request.get("/api/repos");
  expect(res.status()).toBe(401);
});

test("setup cannot run twice", async ({ request }) => {
  const res = await request.post("/api/auth/setup", {
    data: { username: "x", password: "yyyyyyyyyy" },
    headers: { "X-CSRF-Token": "any" },
  });
  expect(res.status()).toBe(409);
});
