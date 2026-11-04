import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Scene } from "../../src/shared/scene";
import type { Point, Rect } from "../../src/shared/types";
import type { PageDriver } from "../../src/main/core/page-driver";
import { loginWithAccount } from "../../src/main/runner/login";

const roots: string[] = [];
const ENV_NAME = "MALO_BROWSER_LOGIN_TEST_PASSWORD";

afterEach(async () => {
  delete process.env[ENV_NAME];
  delete process.env.MALO_BROWSER_ACCOUNTS;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class Driver implements PageDriver {
  currentUrl = "about:blank";
  navigations: string[] = [];
  inserted: string[] = [];
  clicks: Point[] = [];

  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    this.currentUrl = url;
  }
  async waitForSelector(): Promise<void> {}
  async waitForText(): Promise<void> {}
  async waitForUrl(): Promise<void> {}
  async evaluate<T>(): Promise<T> {
    return true as T;
  }
  async rect(selector: string): Promise<Rect> {
    return { x: 10, y: 20, left: 0, top: 10, width: 20, height: 20 };
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async move(): Promise<void> {}
  async click(point: Point): Promise<void> {
    this.clicks.push(point);
  }
  async insertText(text: string): Promise<void> {
    this.inserted.push(text);
  }
  async press(): Promise<void> {}
  async selectAll(): Promise<void> {}
  async scroll(): Promise<void> {}
  async screenshot(): Promise<void> {}
}

const scene: Scene = {
  schemaVersion: 1,
  id: "login-test",
  title: "Login Test",
  url: "https://app.example.test/",
  viewport: { width: 1440, height: 900 },
  profile: "demo",
  allow: ["https://app.example.test"],
  permissions: [],
  resetPolicy: "reload",
  vars: {},
  steps: [],
  rootDir: "/tmp/login-test",
};

async function configureAccount(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "malo-browser-login-"));
  roots.push(root);
  const file = path.join(root, "accounts.json");
  await writeFile(
    file,
    JSON.stringify({
      schema_version: 1,
      accounts: {
        work: {
          origin: "https://app.example.test",
          login_url: "https://app.example.test/login",
          username: "demo@example.test",
          password_env: ENV_NAME,
          username_selector: "input[name=email]",
          password_selector: "input[name=password]",
          submit_selector: "button[type=submit]",
          success_selector: "[data-dashboard]",
        },
      },
    }),
    { mode: 0o600 },
  );
  await chmod(file, 0o600);
  process.env.MALO_BROWSER_ACCOUNTS = file;
}

async function configureDemoAccount(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "malo-browser-login-"));
  roots.push(root);
  const file = path.join(root, "accounts.json");
  await writeFile(
    file,
    JSON.stringify({
      schema_version: 1,
      accounts: {
        fixture: {
          origin: "demo://scene/login-test",
          login_url: "demo://scene/login-test/index.html",
          username: "demo@example.test",
          password_env: ENV_NAME,
          username_selector: "input[name=email]",
          password_selector: "input[name=password]",
          submit_selector: "button[type=submit]",
          success_selector: "#signed-in",
        },
      },
    }),
    { mode: 0o600 },
  );
  await chmod(file, 0o600);
  process.env.MALO_BROWSER_ACCOUNTS = file;
}

describe("loginWithAccount", () => {
  it("navigates, fills, submits and verifies without exposing the password", async () => {
    await configureAccount();
    process.env[ENV_NAME] = "sentinel-password";
    const driver = new Driver();

    const result = await loginWithAccount({
      driver,
      scene,
      accountId: "work",
      timeoutMs: 1000,
    });

    expect(driver.navigations).toEqual(["https://app.example.test/login"]);
    expect(driver.inserted).toEqual(["demo@example.test", "sentinel-password"]);
    expect(driver.clicks).toHaveLength(3);
    expect(result.detail).toBe('signed in with account "work"');
    expect(JSON.stringify(result)).not.toContain("sentinel-password");
  });

  it("fails on a missing password environment variable before navigation", async () => {
    await configureAccount();
    const driver = new Driver();

    await expect(
      loginWithAccount({ driver, scene, accountId: "work", timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "E_ACCOUNT_INVALID" });
    expect(driver.navigations).toEqual([]);
    expect(driver.inserted).toEqual([]);
  });

  it("refuses to type after a cross-origin redirect", async () => {
    await configureAccount();
    process.env[ENV_NAME] = "sentinel-password";
    const driver = new Driver();
    driver.navigate = async (url: string) => {
      driver.navigations.push(url);
      driver.currentUrl = "https://evil.example.test/login";
    };

    await expect(
      loginWithAccount({ driver, scene, accountId: "work", timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "E_ACCOUNT_INVALID" });
    expect(driver.inserted).toEqual([]);
  });

  it("allows a demo scene origin introduced by the file-scene policy", async () => {
    await configureDemoAccount();
    process.env[ENV_NAME] = "sentinel-password";
    const demoScene: Scene = {
      ...scene,
      url: undefined,
      file: "index.html",
      allow: [],
      rootDir: "/tmp/login-test",
    };

    await expect(
      loginWithAccount({
        driver: new Driver(),
        scene: demoScene,
        accountId: "fixture",
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ detail: 'signed in with account "fixture"' });
  });
});
