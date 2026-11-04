import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  controlApiTokenHint,
  createEncodeProgressLine,
  explainListenFailure,
  explainLoadFailure,
  formatOverwriteWarning,
  resolveToolOnPath,
  runToolWithProgress,
} from "../../src/main/tools";
import { DemoError, errorCodeFor } from "../../src/shared/errors";

describe("explainLoadFailure", () => {
  it("fixture 默认地址连接被拒时给出可直接复制的服务启动命令", () => {
    const original = new Error("net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4788/index.html");
    const explained = explainLoadFailure("http://127.0.0.1:4788/index.html", original);
    expect(explained).not.toBe(original);
    expect(explained).toBeInstanceOf(Error);
    const message = (explained as Error).message;
    expect(message).toContain("http://127.0.0.1:4788/index.html");
    expect(message).toContain("net::ERR_CONNECTION_REFUSED");
    expect(message).toContain("python3 -m http.server 4788 --bind 127.0.0.1 --directory out/fixture");
    expect((explained as Error).cause).toBe(original);
  });

  it("非默认地址连接被拒时只给通用指引，不误导成 fixture 服务", () => {
    const original = new Error("net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9999/app");
    const explained = explainLoadFailure("http://127.0.0.1:9999/app", original) as Error;
    expect(explained.message).toContain("http://127.0.0.1:9999/app");
    expect(explained.message).not.toContain("fixture");
    expect(explained.message).not.toContain("4788");
  });

  it("连接被拒以外的错误原样返回同一引用，不改写", () => {
    const original = new Error("net::ERR_NAME_NOT_RESOLVED at http://example.test/");
    expect(explainLoadFailure("http://example.test/", original)).toBe(original);
  });

  it("非 Error 输入也能识别并生成指引", () => {
    const explained = explainLoadFailure(
      "http://127.0.0.1:4788/index.html",
      "boom: net::ERR_CONNECTION_REFUSED",
    ) as Error;
    expect(explained).toBeInstanceOf(Error);
    expect(explained.message).toContain("python3 -m http.server 4788");
  });
});

describe("controlApiTokenHint", () => {
  it("指明 token 落盘路径与文档指引，单行不折断", () => {
    const hint = controlApiTokenHint("/tmp/out/control.json");
    expect(hint).toContain("/tmp/out/control.json");
    expect(hint).toContain("README.md 的 App control API 节");
    expect(hint).not.toContain("\n");
  });

  it("传入的 recordFile 路径原样嵌入，不同输出目录各指各的", () => {
    expect(controlApiTokenHint("evidence/control.json")).toContain("evidence/control.json");
    expect(controlApiTokenHint("out/control.json")).toContain("out/control.json");
  });
});

describe("explainListenFailure", () => {
  const busy = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:7410"), {
    code: "EADDRINUSE",
  });

  it("控制 API 端口冲突指向 --control-port", () => {
    const message = (explainListenFailure(7317, busy, "control") as Error).message;
    expect(message).toContain("127.0.0.1:7317");
    expect(message).toContain("--control-port");
    expect(message).not.toContain("--daemon-port");
  });

  it("broker 端口冲突指向 --daemon-port，不再让用户去改控制 API 端口", () => {
    const message = (explainListenFailure(7410, busy, "broker") as Error).message;
    expect(message).toContain("broker");
    expect(message).toContain("127.0.0.1:7410");
    expect(message).toContain("--daemon-port");
    expect(message).not.toContain("--control-port");
  });

  it("lease 端口冲突指向端口池参数", () => {
    const message = (explainListenFailure(7411, busy, "lease") as Error).message;
    expect(message).toContain("--port-min/--port-max");
  });

  it("非端口冲突错误原样返回同一引用", () => {
    const original = new Error("boom");
    expect(explainListenFailure(7317, original, "control")).toBe(original);
  });
});

describe("formatOverwriteWarning", () => {
  it("没有已存在的产物时返回 null，不打扰首次录制", () => {
    expect(formatOverwriteWarning("hidden", [])).toBeNull();
  });

  it("列出将被覆盖的每个旧文件并给出换 --label 的出路", () => {
    const warning = formatOverwriteWarning("hidden", [
      "/tmp/evidence/hidden.mp4",
      "/tmp/evidence/hidden.evidence.json",
      "/tmp/evidence/hidden.overlay-frame.png",
    ]);
    expect(warning).toContain("hidden");
    expect(warning).toContain("/tmp/evidence/hidden.mp4");
    expect(warning).toContain("/tmp/evidence/hidden.evidence.json");
    expect(warning).toContain("/tmp/evidence/hidden.overlay-frame.png");
    expect(warning).toContain("--label");
  });

  it("只存在部分产物时只列实际存在的那些", () => {
    const warning = formatOverwriteWarning("demo", ["/tmp/out/demo.mp4"]);
    expect(warning).toContain("/tmp/out/demo.mp4");
    expect(warning).not.toContain("evidence.json");
  });
});

describe("runToolWithProgress", () => {
  it("ffmpeg -progress 输出在每个 progress= 行回调最近一次 frame= 值", async () => {
    const frames: number[] = [];
    await runToolWithProgress(
      process.execPath,
      [
        "-e",
        "console.log('frame=0');console.log('fps=30');console.log('progress=continue');" +
          "console.log('frame=150');console.log('progress=end');",
      ],
      (frame) => frames.push(frame),
    );
    expect(frames).toEqual([0, 150]);
  });

  it("退出码非 0 时与 runTool 同款语义报 stderr 尾部", async () => {
    await expect(
      runToolWithProgress(process.execPath, [
        "-e",
        "console.error('boom-a');console.error('boom-b');process.exit(3)",
      ]),
    ).rejects.toThrow(/boom-a \| boom-b/);
  });

  it("可执行文件不存在时 fail-loud 报执行失败", async () => {
    await expect(runToolWithProgress("/nonexistent-tool-bin", [])).rejects.toThrow(/执行失败/);
  });
});

describe("createEncodeProgressLine", () => {
  it("每 10% 桶至多打一行，0% 与同桶不重复打", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const report = createEncodeProgressLine(300);
      report(0);
      report(29);
      report(30);
      report(45);
      report(300);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenNthCalledWith(1, expect.stringContaining("10%"));
      expect(spy).toHaveBeenNthCalledWith(2, expect.stringContaining("100%"));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("resolveToolOnPath", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function toolDir(name: "ffmpeg" | "ffprobe"): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), `malo-${name}-`));
    dirs.push(dir);
    const file = path.join(dir, name);
    await writeFile(file, "#!/bin/sh\nexit 0\n");
    await chmod(file, 0o755);
    return dir;
  }

  it("uses the PATH hit before any fallback directory", async () => {
    const onPath = await toolDir("ffmpeg");
    const fallback = await toolDir("ffmpeg");
    expect(resolveToolOnPath("ffmpeg", onPath, [fallback])).toBe(path.join(onPath, "ffmpeg"));
  });

  it("falls back to the documented directories when PATH has no hit", async () => {
    const fallback = await toolDir("ffprobe");
    expect(resolveToolOnPath("ffprobe", "", [fallback])).toBe(path.join(fallback, "ffprobe"));
  });

  it("throws E_FFMPEG_MISSING when neither PATH nor the fallbacks have the tool", async () => {
    const missing = await mkdtemp(path.join(os.tmpdir(), "malo-missing-"));
    await rm(missing, { recursive: true, force: true });
    let failure: unknown;
    try {
      resolveToolOnPath("ffmpeg", missing, [path.join(missing, "homebrew")]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DemoError);
    expect((failure as DemoError).code).toBe("E_FFMPEG_MISSING");
    expect((failure as Error).message).toContain("找不到 ffmpeg");
  });
});

describe("errorCodeFor", () => {
  it("keeps a DemoError code and extracts the Chromium code from a wrapped load failure", () => {
    expect(errorCodeFor(new DemoError("E_FFMPEG_FAILED", "boom"))).toBe("E_FFMPEG_FAILED");
    expect(
      errorCodeFor(new Error("页面无法连接：http://127.0.0.1:1/（net::ERR_CONNECTION_REFUSED）")),
    ).toBe("ERR_CONNECTION_REFUSED");
  });

  it("falls back to E_RECORDER_FAILED for plain errors without a code", () => {
    expect(errorCodeFor(new Error("boom"))).toBe("E_RECORDER_FAILED");
  });
});
