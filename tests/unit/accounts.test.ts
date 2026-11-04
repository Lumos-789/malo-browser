import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAccountProfile } from "../../src/main/auth/accounts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function account(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    origin: "https://app.example.test",
    login_url: "https://app.example.test/login",
    username: "demo@example.test",
    password_env: "MALO_BROWSER_TEST_PASSWORD",
    username_selector: "input[name=email]",
    password_selector: "input[name=password]",
    submit_selector: "button[type=submit]",
    success_selector: "[data-dashboard]",
    ...overrides,
  };
}

async function writeStore(
  accounts: Record<string, unknown>,
  mode = 0o600,
): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "malo-browser-accounts-"));
  roots.push(root);
  const file = path.join(root, "accounts.json");
  await writeFile(file, JSON.stringify({ schema_version: 1, accounts }), { mode });
  await chmod(file, mode);
  return { root, file };
}

describe("loadAccountProfile", () => {
  it("loads a typed profile without resolving or exposing the password", async () => {
    const { file } = await writeStore({ work: account() });

    const profile = await loadAccountProfile("work", { file });

    expect(profile).toEqual({
      id: "work",
      origin: "https://app.example.test",
      loginUrl: "https://app.example.test/login",
      username: "demo@example.test",
      passwordEnv: "MALO_BROWSER_TEST_PASSWORD",
      usernameSelector: "input[name=email]",
      passwordSelector: "input[name=password]",
      submitSelector: "button[type=submit]",
      successSelector: "[data-dashboard]",
      successUrl: undefined,
    });
  });

  it("rejects group or world readable account files", async () => {
    const { file } = await writeStore({ work: account() }, 0o644);

    await expect(loadAccountProfile("work", { file })).rejects.toMatchObject({
      code: "E_ACCOUNT_INVALID",
      message: expect.stringContaining("0600"),
    });
  });

  it("rejects unknown fields and missing success checks", async () => {
    const unknown = await writeStore({ work: account({ password: "must-not-be-inline" }) });
    await expect(loadAccountProfile("work", { file: unknown.file })).rejects.toMatchObject({
      code: "E_ACCOUNT_INVALID",
    });

    const noSuccess = await writeStore({
      work: account({ success_selector: undefined, success_url: undefined }),
    });
    await expect(loadAccountProfile("work", { file: noSuccess.file })).rejects.toMatchObject({
      code: "E_ACCOUNT_INVALID",
    });
  });

  it("reports configured account ids when the requested account is absent", async () => {
    const { file } = await writeStore({ work: account(), staging: account() });

    await expect(loadAccountProfile("production", { file })).rejects.toMatchObject({
      code: "E_ACCOUNT_NOT_FOUND",
      details: { available: ["staging", "work"] },
    });
  });

  it("rejects an account file kept inside a git worktree", async () => {
    const { root, file } = await writeStore({ work: account() });
    await mkdir(path.join(root, ".git"));

    await expect(loadAccountProfile("work", { file })).rejects.toMatchObject({
      code: "E_ACCOUNT_INVALID",
      message: expect.stringContaining("outside a git worktree"),
    });
  });

  it("uses MALO_BROWSER_ACCOUNTS as the default account file", async () => {
    const { file } = await writeStore({ work: account() });
    const previous = process.env.MALO_BROWSER_ACCOUNTS;
    process.env.MALO_BROWSER_ACCOUNTS = file;
    try {
      await expect(loadAccountProfile("work")).resolves.toMatchObject({ id: "work" });
    } finally {
      if (previous === undefined) delete process.env.MALO_BROWSER_ACCOUNTS;
      else process.env.MALO_BROWSER_ACCOUNTS = previous;
    }
  });
});
