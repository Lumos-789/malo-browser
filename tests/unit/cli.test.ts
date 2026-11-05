import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { isHelpRequested, isVersionRequested, KNOWN_FLAGS, parseOptions, USAGE } from "../../src/main/cli";

describe("cli window defaults", () => {
  it("opens the stage without focus for an interactive app session", () => {
    expect(parseOptions(["--mode=app"]).windowMode).toBe("inactive");
  });

  it("keeps recording headless for autorun", () => {
    expect(parseOptions(["--mode=app", "--autorun=report-review"]).windowMode).toBe("hidden");
  });

  it("keeps the probe headless", () => {
    expect(parseOptions(["--mode=app", "--director-check"]).windowMode).toBe("hidden");
  });

  it("treats --headless as no visible UI at all", () => {
    const options = parseOptions(["--mode=app", "--headless=true"]);
    expect(options.headless).toBe(true);
    expect(options.windowMode).toBe("hidden");
  });

  it("honours an explicit window mode over the interactive default", () => {
    expect(parseOptions(["--mode=app", "--window-mode=hidden"]).windowMode).toBe("hidden");
    expect(parseOptions(["--mode=app", "--window-mode=focused"]).windowMode).toBe("focused");
  });

  it("parses control api flags", () => {
    const options = parseOptions(["--mode=app", "--control-api=true", "--control-port=7399"]);
    expect(options.controlApi).toBe(true);
    expect(options.controlPort).toBe(7399);
  });

  it("rejects an unknown window mode", () => {
    expect(() => parseOptions(["--mode=app", "--window-mode=teleport"])).toThrow(/window-mode|窗口模式/);
  });
});

describe("cli flag validation", () => {
  it("rejects a misspelled flag instead of silently ignoring it", () => {
    expect(() => parseOptions(["--mode=record", "--widht=1920"])).toThrow(/widht.*--help/);
  });

  it("rejects an unknown bare flag", () => {
    expect(() => parseOptions(["--verbose"])).toThrow(/--verbose/);
  });

  it("still accepts the full README flag set", () => {
    const options = parseOptions([
      "--mode=record",
      "--url=http://127.0.0.1:4788/index.html",
      "--out=evidence",
      "--seconds=5",
      "--width=1920",
      "--height=1080",
      "--label=take",
      "--window-mode=ghost",
      "--focus-emulation=false",
      "--plain=true",
      "--keep-frames=true",
    ]);
    expect(options.seconds).toBe(5);
    expect(options.width).toBe(1920);
    expect(options.height).toBe(1080);
    expect(options.label).toBe("take");
    expect(options.windowMode).toBe("ghost");
    expect(options.focusEmulation).toBe(false);
    expect(options.plain).toBe(true);
    expect(options.keepFrames).toBe(true);
  });

  it("passes through Electron dev switches", () => {
    expect(() => parseOptions(["--mode=app", "--inspect=9229"])).not.toThrow();
  });

  it("detects --help and -h without launching the app", () => {
    expect(isHelpRequested(["--mode=app", "--help"])).toBe(true);
    expect(isHelpRequested(["-h"])).toBe(true);
    expect(isHelpRequested(["--mode=app"])).toBe(false);
  });

  it("usage documents every known flag", () => {
    for (const flag of KNOWN_FLAGS) {
      expect(USAGE).toContain(`--${flag}`);
    }
  });

  it("detects --version and -v without launching the app", () => {
    expect(isVersionRequested(["--mode=app", "--version"])).toBe(true);
    expect(isVersionRequested(["-v"])).toBe(true);
    expect(isVersionRequested(["--mode=app"])).toBe(false);
  });

  it("accepts --version as a known flag", () => {
    expect(KNOWN_FLAGS).toContain("version");
  });
});

describe("cli label validation", () => {
  it("rejects a label containing a slash before it can escape the output dir", () => {
    expect(() => parseOptions(["--mode=record", "--label=demo-2026/11/03"])).toThrow(/--label.*demo-2026\/11\/03.*--out/s);
    expect(() => parseOptions(["--mode=record", "--label=../escape"])).toThrow(/--label/);
  });

  it("rejects a label containing a backslash", () => {
    expect(() => parseOptions(["--mode=record", "--label=take\\1"])).toThrow(/--label/);
  });

  it("rejects an empty or dot-only label", () => {
    expect(() => parseOptions(["--mode=record", "--label="])).toThrow(/--label.*不能为空/s);
    expect(() => parseOptions(["--mode=record", "--label=.."])).toThrow(/--label/);
  });

  it("keeps accepting ordinary labels, including spaces and unicode", () => {
    expect(parseOptions(["--mode=record", "--label=take 2 最终"]).label).toBe("take 2 最终");
  });
});

describe("cli daemon flags", () => {
  it("parses broker and lease defaults", () => {
    const options = parseOptions(["--mode=daemon"]);
    expect(options.daemonPort).toBe(7410);
    expect(options.portMin).toBe(7411);
    expect(options.portMax).toBe(7499);
    expect(options.leaseTtlSeconds).toBe(300);
    expect(options.sessionIdleSeconds).toBe(300);
    expect(options.maxSessionsPerLease).toBe(4);
    expect(options.dataDir.endsWith(".malo-browser")).toBe(true);
  });

  it("accepts an isolated port range and explicit data dir", () => {
    const options = parseOptions([
      "--mode=daemon",
      "--daemon-port=7450",
      "--port-min=7460",
      "--port-max=7470",
      "--lease-ttl-seconds=60",
      "--session-idle-seconds=30",
      "--max-sessions=2",
      "--data-dir=/tmp/malo-test",
    ]);
    expect(options.daemonPort).toBe(7450);
    expect(options.portMin).toBe(7460);
    expect(options.portMax).toBe(7470);
    expect(options.leaseTtlSeconds).toBe(60);
    expect(options.sessionIdleSeconds).toBe(30);
    expect(options.maxSessionsPerLease).toBe(2);
    expect(options.dataDir).toBe("/tmp/malo-test");
  });

  it("rejects fractional, out-of-range and overlapping ports", () => {
    expect(() => parseOptions(["--mode=daemon", "--daemon-port=7410.5"])).toThrow(/65535/);
    expect(() => parseOptions(["--mode=daemon", "--port-max=70000"])).toThrow(/65535/);
    expect(() => parseOptions(["--mode=daemon", "--port-min=7500", "--port-max=7400"])).toThrow(/范围无效/);
    expect(() => parseOptions(["--mode=daemon", "--daemon-port=7415"])).toThrow(/不能落在/);
  });

  it("rejects zero or fractional limits", () => {
    expect(() => parseOptions(["--mode=daemon", "--lease-ttl-seconds=0"])).toThrow(/正数/);
    expect(() => parseOptions(["--mode=daemon", "--session-idle-seconds=1.5"])).toThrow(/整数/);
    expect(() => parseOptions(["--mode=daemon", "--max-sessions=0"])).toThrow(/正数/);
    expect(() => parseOptions(["--mode=daemon", "--max-sessions=65"])).toThrow(/1-64/);
  });
});

describe("cli path expansion", () => {
  it("expands a leading ~ instead of creating a literal ~ directory", () => {
    const home = os.homedir();
    const opts = parseOptions([
      "--mode=daemon",
      "--data-dir=~/.malo-browser",
      "--out=~/evidence",
      "--scenes=~/scenes",
    ]);
    expect(opts.dataDir).toBe(path.join(home, ".malo-browser"));
    expect(opts.outDir).toBe(path.join(home, "evidence"));
    expect(opts.scenesRoot).toBe(path.join(home, "scenes"));
  });

  it("leaves absolute and relative paths untouched", () => {
    const opts = parseOptions(["--mode=daemon", "--data-dir=/tmp/malo", "--out=./out"]);
    expect(opts.dataDir).toBe("/tmp/malo");
    expect(opts.outDir).toBe("./out");
  });
});
