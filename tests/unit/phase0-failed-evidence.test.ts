import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options } from "../../src/main/cli";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.1.4",
    getAppMetrics: () => [],
  },
}));

vi.mock("../../src/main/stage-window", () => ({
  createStage: () => ({
    window: { isVisible: () => false, on: () => undefined },
    view: {
      webContents: {
        loadURL: async () => {
          throw new Error(
            "ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:4788/index.html'",
          );
        },
      },
    },
    showMode: "hidden",
    close: () => undefined,
  }),
}));

vi.mock("../../src/main/cdp-page", () => ({
  CdpPage: class {
    constructor(_webContents: unknown) {}
    detach(): void {}
  },
}));

import { runPhase0 } from "../../src/main/phase0";

let workDir: string;

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function recordOptions(outDir: string): Options {
  return {
    mode: "record",
    windowMode: "hidden",
    focusEmulation: true,
    plain: false,
    url: "http://127.0.0.1:4788/index.html",
    outDir,
    seconds: 3,
    width: 1440,
    height: 900,
    label: "unreachable",
    keepFrames: false,
    scenesRoot: path.join(outDir, "scenes"),
    showStage: false,
    autorun: null,
    directorCheck: false,
    controlApi: false,
    controlPort: 7317,
    headless: true,
    daemonPort: 7410,
    portMin: 7411,
    portMax: 7499,
    leaseTtlSeconds: 300,
    sessionIdleSeconds: 300,
    maxSessionsPerLease: 4,
    dataDir: path.join(outDir, "data"),
  };
}

describe("failed --mode=record evidence", () => {
  it("opens the stage inside the failure boundary and records ERR_CONNECTION_REFUSED", async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), "malo-phase0-failure-"));
    const outDir = path.join(workDir, "evidence");

    const failure = await runPhase0(recordOptions(outDir)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("net::ERR_CONNECTION_REFUSED");

    const evidencePath = path.join(outDir, "unreachable.evidence.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    expect(evidence.schema_version).toBe(1);
    expect(evidence.kind).toBe("demo-stage-recording");
    expect(evidence.status).toBe("failed");
    expect(evidence.video).toBeNull();
    expect(evidence.scene.url).toBe("http://127.0.0.1:4788/index.html");
    expect(evidence.run.mode).toBe("record");
    expect(evidence.steps).toEqual([]);
    expect(evidence.error).toMatchObject({
      code: "ERR_CONNECTION_REFUSED",
      step: "open-stage",
    });
    expect(evidence.error.message).toContain("页面无法连接");
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.warnings[0]).toContain("no video was written");
  });
});
