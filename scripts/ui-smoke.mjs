import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const dir = await mkdtemp(join(tmpdir(), "vault-ui-")),
  errors = [];
const server = spawn(process.execPath, ["--import", "tsx", "src/local.ts"], {
  env: {
    ...process.env,
    STORAGE_MODE: "local-development",
    LOCAL_MOCK_TELEGRAM: "true",
    SERVER_KEY: randomBytes(32).toString("hex"),
    SETUP_TOKEN: "s".repeat(64),
    LOCAL_STATE_PATH: join(dir, "state"),
    APP_ORIGIN: "http://127.0.0.1:3000",
    BOT_TOKEN: "",
    CHANNEL_ID: "",
  },
  stdio: "pipe",
});
let browser;
try {
  await new Promise((resolve, reject) => {
    server.stdout.once("data", resolve);
    server.once("error", reject);
    server.once("exit", () => reject(Error("Server exited")));
  });
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:3000");
  await page
    .getByRole("button", { name: "Initial setup", exact: true })
    .click();
  await page.getByLabel("One-time setup token").fill("s".repeat(64));
  await page.getByLabel("Vault username").fill("synthetic");
  await page.getByLabel("Master password ·").fill("synthetic master password");
  await page.getByRole("button", { name: "Create vault", exact: true }).click();
  await page.getByText("Store your recovery key.", { exact: true }).waitFor();
  const recovery = await page.locator(".recovery-key").innerText();
  assert.match(recovery, /^[a-f0-9]{64}$/);
  await page.locator("#ack").check();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await page.getByText("Your digital essentials.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "＋ Add new" }).click();
  await page.getByLabel("Service name").fill("Synthetic UI");
  await page.getByLabel("Website URL").fill("https://example.com");
  await page.getByLabel("Username / email").fill("synthetic@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic-only-secret");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .locator(".backdrop")
    .waitFor({ state: "detached" })
    .catch(async (e) => {
      console.error("UI error:", await page.locator("#message").textContent());
      throw e;
    });
  await page.locator("article summary").click();
  await page.getByRole("button", { name: "Reveal", exact: true }).click();
  await page.getByText("synthetic-only-secret", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Service name").fill("Synthetic UI edited");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator("article summary").click();
  await page.getByRole("button", { name: "Reveal", exact: true }).click();
  await page.getByText("synthetic-only-secret", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Backup & restore", exact: true })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download encrypted backup" }).click();
  const download = await downloadPromise;
  const backupPath = join(dir, "backup.json");
  await download.saveAs(backupPath);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.screenshot({ path: "work/ui-mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.getByRole("button", { name: "Lock vault", exact: true }).click();
  await page.getByText("Welcome back.", { exact: true }).waitFor();
  await page.getByLabel("Vault username").fill("synthetic");
  await page
    .getByLabel("Master password", { exact: true })
    .fill("synthetic master password");
  await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
  await page.getByText("Your digital essentials.", { exact: true }).waitFor();
  // Download-independent recovery page, loaded from file:// with networking blocked.
  const offline = await browser.newPage();
  let network = 0;
  await offline.goto("http://127.0.0.1:3000/recovery.html");
  await offline.waitForFunction(
    () => document.querySelector("form").onsubmit !== null,
  );
  await offline.context().setOffline(true);
  await offline.route("**/*", (route) => {
    network++;
    return route.abort();
  });
  await offline.getByLabel("Encrypted backup").setInputFiles(backupPath);
  await offline.getByLabel("Recovery key").fill(recovery);
  await offline
    .getByRole("button", { name: "Decrypt & preview locally" })
    .click();
  await offline.getByText(/Authenticated: 1 passwords/).waitFor();
  assert.equal(network, 0);
  assert.deepEqual(errors, []);
  console.log(
    "UI smoke passed: mobile setup, acknowledgement, add, reveal, edit preserving password, backup, logout/login, and browser recovery with networking disabled.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  await rm(dir, { recursive: true, force: true });
}
