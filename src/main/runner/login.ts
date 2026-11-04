import { DemoError } from "../../shared/errors";
import type { Scene } from "../../shared/scene";
import { loadAccountProfile } from "../auth/accounts";
import type { PageDriver } from "../core/page-driver";
import { buildSecurityPolicy, isAllowedNavigation, normalizeOrigin } from "../security";

export type LoginOptions = {
  driver: PageDriver;
  scene: Scene;
  accountId: string;
  timeoutMs: number;
};

export async function loginWithAccount(options: LoginOptions): Promise<{ detail: string }> {
  const { driver, scene, accountId, timeoutMs } = options;
  const account = await loadAccountProfile(accountId);
  const password = process.env[account.passwordEnv];
  if (!password) {
    throw new DemoError(
      "E_ACCOUNT_INVALID",
      `login account "${accountId}" requires environment variable ${account.passwordEnv}`,
      { details: { accountId, passwordEnv: account.passwordEnv } },
    );
  }

  const navigation = isAllowedNavigation(account.loginUrl, buildSecurityPolicy(scene).allow);
  if (!navigation.allowed) {
    throw new DemoError(
      "E_NAV_BLOCKED",
      `login navigation blocked for account "${accountId}": ${navigation.reason}`,
      { url: account.loginUrl, details: { accountId } },
    );
  }

  await driver.navigate(account.loginUrl, { timeoutMs });
  const liveOrigin = originOf(await driver.url());
  if (liveOrigin !== account.origin) {
    throw new DemoError(
      "E_ACCOUNT_INVALID",
      `login page moved from ${account.origin} to ${liveOrigin}; refusing to type credentials`,
      { details: { accountId } },
    );
  }

  await driver.waitForSelector(account.usernameSelector, "visible", timeoutMs);
  await driver.waitForSelector(account.passwordSelector, "visible", timeoutMs);
  await fill(driver, account.usernameSelector, account.username);
  await fill(driver, account.passwordSelector, password);
  await driver.waitForSelector(account.submitSelector, "visible", timeoutMs);
  await click(driver, account.submitSelector);

  if (account.successSelector) {
    try {
      await driver.waitForSelector(account.successSelector, "visible", timeoutMs);
    } catch (error) {
      throw loginFailure("success selector", accountId, error);
    }
  }
  if (account.successUrl) {
    try {
      await driver.waitForUrl(account.successUrl, timeoutMs);
    } catch (error) {
      throw loginFailure("success URL", accountId, error);
    }
  }

  return { detail: `signed in with account "${accountId}"` };
}

async function fill(
  driver: PageDriver,
  selector: string,
  value: string,
): Promise<void> {
  const point = await driver.rect(selector);
  await driver.move({ x: point.x, y: point.y });
  await driver.click({ x: point.x, y: point.y }, { button: "left", clickCount: 1 });
  await driver.selectAll();
  await driver.press("Backspace");
  await driver.insertText(value);
}

async function click(driver: PageDriver, selector: string): Promise<void> {
  const point = await driver.rect(selector);
  await driver.move({ x: point.x, y: point.y });
  await driver.click({ x: point.x, y: point.y }, { button: "left", clickCount: 1 });
}

function originOf(raw: string): string {
  try {
    return normalizeOrigin(raw, "page URL");
  } catch {
    return "invalid-origin";
  }
}

function loginFailure(phase: string, accountId: string, error: unknown): DemoError {
  if (error instanceof DemoError) {
    return new DemoError(error.code, `login ${phase} failed for account "${accountId}"`, {
      details: { accountId, phase },
    });
  }
  return new DemoError("E_UNSUPPORTED", `login ${phase} failed for account "${accountId}"`, {
    details: { accountId, phase },
  });
}
