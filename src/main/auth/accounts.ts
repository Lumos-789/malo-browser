import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DemoError } from "../../shared/errors";
import { normalizeOrigin } from "../security";

const accountIdSchema = z.string().regex(/^[a-z0-9-]+$/);
const accountSchema = z
  .object({
    origin: z.string().min(1),
    login_url: z.string().min(1),
    username: z.string().min(1),
    password_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    username_selector: z.string().min(1),
    password_selector: z.string().min(1),
    submit_selector: z.string().min(1),
    success_selector: z.string().min(1).optional(),
    success_url: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((account, ctx) => {
    if (!account.success_selector && !account.success_url) {
      ctx.addIssue({
        code: "custom",
        path: ["success_selector"],
        message: "requires success_selector or success_url",
      });
    }
  });
const storeSchema = z
  .object({
    schema_version: z.literal(1),
    accounts: z.record(accountIdSchema, accountSchema),
  })
  .strict();

export type AccountProfile = {
  id: string;
  origin: string;
  loginUrl: string;
  username: string;
  passwordEnv: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  successSelector?: string;
  successUrl?: string;
};

export type LoadAccountOptions = {
  file?: string;
};

export function defaultAccountsFile(): string {
  return path.resolve(
    process.env.MALO_BROWSER_ACCOUNTS ??
      path.join(os.homedir(), ".config", "malo-browser", "accounts.json"),
  );
}

function insideGitWorktree(file: string): boolean {
  let current = path.dirname(file);
  while (true) {
    if (existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function invalid(message: string, details?: Record<string, unknown>): DemoError {
  return new DemoError("E_ACCOUNT_INVALID", message, { details });
}

export async function loadAccountProfile(
  accountId: string,
  options: LoadAccountOptions = {},
): Promise<AccountProfile> {
  if (!accountIdSchema.safeParse(accountId).success) {
    throw invalid(`account id must match [a-z0-9-]+: ${accountId}`);
  }

  const file = path.resolve(options.file ?? defaultAccountsFile());
  if (insideGitWorktree(file)) {
    throw invalid("account file must live outside a git worktree", { path: file });
  }

  let fileStat;
  try {
    fileStat = await lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new DemoError("E_ACCOUNT_NOT_FOUND", `account file not found: ${file}`, {
        details: { path: file },
      });
    }
    throw invalid(`cannot inspect account file: ${file}`);
  }
  if (fileStat.isSymbolicLink()) {
    throw invalid("account file must not be a symbolic link", { path: file });
  }
  if (!fileStat.isFile()) {
    throw invalid("account path must be a regular file", { path: file });
  }
  if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
    throw invalid("account file permissions must be 0600", { path: file, mode: fileStat.mode & 0o777 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw invalid("account file is not valid UTF-8 JSON", {
      path: file,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const parsed = storeSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw invalid("account file has an invalid schema", {
      path: file,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const raw = parsed.data.accounts[accountId];
  if (!raw) {
    throw new DemoError("E_ACCOUNT_NOT_FOUND", `account "${accountId}" is not configured`, {
      details: { path: file, available: Object.keys(parsed.data.accounts).sort() },
    });
  }

  let origin: string;
  let loginOrigin: string;
  try {
    origin = normalizeOrigin(raw.origin, "account.origin");
    loginOrigin = normalizeOrigin(raw.login_url, "account.login_url");
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error), { path: file });
  }
  if (origin !== loginOrigin) {
    throw invalid("login_url must use the same origin as origin", {
      path: file,
      origin,
      loginOrigin,
    });
  }

  return {
    id: accountId,
    origin,
    loginUrl: raw.login_url,
    username: raw.username,
    passwordEnv: raw.password_env,
    usernameSelector: raw.username_selector,
    passwordSelector: raw.password_selector,
    submitSelector: raw.submit_selector,
    successSelector: raw.success_selector,
    successUrl: raw.success_url,
  };
}
