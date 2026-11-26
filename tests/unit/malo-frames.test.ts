import { describe, expect, it, vi } from "vitest";
import { frameContext, listFrames, resolveContext } from "../../src/main/malo/frames";
import { executeAction } from "../../src/main/malo/actions/run-action";
import { snapshotPage } from "../../src/main/malo/snapshot";
import { extractElements } from "../../src/main/malo/extract";
import { MALO_TOOLS } from "../../src/shared/malo-tools";
import type { SessionInternals } from "../../src/main/malo/session-internals";

type Rect = { x: number; y: number; left: number; top: number; width: number; height: number };
type Element = { x: number; y: number; width: number; height: number; src: string; name: string; visible: boolean };

type FakeFrame = {
  url: string;
  name: string;
  detached: boolean;
  frames: FakeFrame[];
  executeJavaScript: ReturnType<typeof vi.fn>;
};

const element = (x: number, y: number, width: number, height: number, src: string, visible = true): Element => ({
  x,
  y,
  width,
  height,
  src,
  name: "",
  visible,
});

const rectScript = /document\.querySelector\(("(?:[^"\\]|\\.)*")\)/;

function frame(options: {
  url: string;
  elements?: Element[];
  children?: FakeFrame[];
  rects?: Record<string, Rect | null>;
  content?: Record<string, unknown>;
  failWith?: string;
}): FakeFrame {
  const { url, elements = [], children = [], rects = {}, content = {} } = options;
  return {
    url,
    name: "",
    detached: false,
    frames: children,
    executeJavaScript: vi.fn(async (script: string) => {
      if (options.failWith) throw new Error(options.failWith);
      if (script.includes('querySelectorAll("iframe")')) return elements;
      if (script.includes("const sections =")) return { url, title: `inside ${url}`, frames: [], ...content };
      if (script.includes("innerWidth")) return { width: 300, height: 200 };
      const selector = rectScript.exec(script)?.[1];
      if (selector && selector in rects) return rects[selector];
      throw new Error(`unexpected script: ${script.slice(0, 60)}`);
    }),
  };
}

function session(topElements: Element[], children: FakeFrame[]): SessionInternals {
  const driver = {
    evaluate: vi.fn(async (script: string) => {
      if (script.includes('querySelectorAll("iframe")')) return topElements;
      if (script.includes("const sections =")) {
        return {
          url: "http://127.0.0.1/", title: "top", text: "top text", text_length: 8,
          links: [], buttons: [], inputs: [], frames: [],
        };
      }
      throw new Error(`unexpected top-level script: ${script.slice(0, 60)}`);
    }),
    move: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    rect: vi.fn(async () => ({ x: 1, y: 2 })),
    url: vi.fn(async () => "http://top/"),
  };
  const mainFrame = { frames: children };
  return {
    stage: { view: { webContents: { mainFrame } } },
    driver,
    assertOpen: vi.fn(),
    touch: vi.fn(),
    record: vi.fn(),
  } as unknown as SessionInternals;
}

const U1 = "http://127.0.0.1/a";
const U2 = "http://127.0.0.1/b";
const U3 = "http://127.0.0.1/c";

describe("listFrames", () => {
  it("flattens visible iframes in document order and offsets nested ones by their ancestors", async () => {
    const grand = frame({ url: U3, elements: [], rects: {} });
    const first = frame({ url: U1, elements: [element(40, 120, 100, 60, U3)], children: [grand] });
    const hidden = frame({ url: U2 });
    const third = frame({ url: U2 });
    const s = session(
      [element(100, 50, 300, 200, U1), element(0, 500, 10, 10, U2, false), element(500, 300, 300, 200, U2)],
      [first, hidden, third],
    );

    const frames = await listFrames(s);

    expect(
      frames.map((item) => [item.index, item.parent, item.url, item.offset, item.path, item.rect]),
    ).toEqual([
      [0, null, U1, { x: 100, y: 50 }, [0], { left: 100, top: 50, width: 300, height: 200 }],
      [1, 0, U3, { x: 140, y: 170 }, [0, 0], { left: 140, top: 170, width: 100, height: 60 }],
      [2, null, U2, { x: 500, y: 300 }, [2], { left: 500, top: 300, width: 300, height: 200 }],
    ]);
  });

  it("pairs a frame with the element whose URL matches when the order has drifted", async () => {
    const moved = frame({ url: U2 });
    const other = frame({ url: U1 });
    const s = session([element(10, 10, 100, 100, U1), element(400, 400, 100, 100, U2)], [moved, other]);

    const frames = await listFrames(s);

    expect(frames.map((item) => [item.url, item.offset.x])).toEqual([
      [U2, 400],
      [U1, 10],
    ]);
  });

  it("fails loudly while the iframe list is changing instead of guessing", async () => {
    const s = session([element(0, 0, 10, 10, U1)], [frame({ url: U1 }), frame({ url: U2 })]);
    await expect(listFrames(s)).rejects.toMatchObject({
      code: "E_UNSUPPORTED",
      message: expect.stringContaining("正在变化"),
    });
  });
});

describe("resolveContext", () => {
  const child = () =>
    frame({
      url: U1,
      rects: {
        '"#b"': { x: 60, y: 50, left: 20, top: 30, width: 80, height: 40 },
        '"#gone"': null,
      },
    });

  it("targets the top-level page when no frame is given", async () => {
    const s = session([], []);
    const ctx = await resolveContext(s, {});
    expect(ctx.frame).toBeNull();
    await ctx.rect("#b");
    expect(s.driver.rect).toHaveBeenCalledWith("#b");
  });

  it("converts element boxes to top-level coordinates inside the frame", async () => {
    const inner = child();
    const ctx = await resolveContext(session([element(100, 50, 300, 200, U1)], [inner]), { frame: 0 });

    expect(await ctx.rect("#b")).toEqual({ x: 160, y: 100, left: 120, top: 80, width: 80, height: 40 });
    expect(await ctx.center()).toEqual({ x: 250, y: 150 });
    await expect(ctx.rect("#gone")).rejects.toMatchObject({
      code: "E_SELECTOR_NOT_FOUND",
      message: expect.stringContaining("第 0 个 iframe 里找不到元素 #gone"),
    });
  });

  it("names the frames that do exist when the index is unknown and enforces the URL guard", async () => {
    const s = session([element(0, 0, 10, 10, U1)], [child()]);
    await expect(resolveContext(s, { frame: 5 })).rejects.toMatchObject({
      code: "E_SELECTOR_NOT_FOUND",
      message: expect.stringContaining(`0=${U1}`),
    });
    await expect(resolveContext(s, { frame: 0, frame_url: "elsewhere" })).rejects.toMatchObject({
      code: "E_SELECTOR_NOT_FOUND",
      message: expect.stringContaining("页面变了"),
    });
    await expect(resolveContext(s, { frame: 0, frame_url: "/a" })).resolves.toMatchObject({
      frame: { index: 0 },
    });
    await expect(resolveContext(s, { frame: -1 })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
  });

  it("reports a frame that left the page instead of running scripts against it", async () => {
    const inner = child();
    const ctx = frameContext({ index: 0, parent: null, url: U1, name: "", rect: { left: 0, top: 0, width: 1, height: 1 }, offset: { x: 0, y: 0 }, path: [0], frame: { ...inner, detached: true } as never });
    await expect(ctx.evaluate("1")).rejects.toMatchObject({ code: "E_SELECTOR_NOT_FOUND" });
  });

  it("turns script failures in a frame into the same errors as the top-level page", async () => {
    const inner = frame({ url: U1, failWith: "SyntaxError: Failed to execute 'querySelector'" });
    const ctx = await resolveContext(session([element(0, 0, 10, 10, U1)], [inner]), { frame: 0 });
    await expect(ctx.evaluate("x")).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    inner.executeJavaScript.mockRejectedValueOnce(new Error("boom"));
    await expect(ctx.evaluate("x")).rejects.toMatchObject({ code: "E_UNSUPPORTED", message: expect.stringContaining("boom") });
  });
});

describe("frame-aware actions", () => {
  const inner = () =>
    frame({
      url: U1,
      rects: { '"#b"': { x: 60, y: 50, left: 20, top: 30, width: 80, height: 40 } },
      content: { innerWidth: 300, innerHeight: 200 },
    });

  it("clicks inside an iframe at the element's top-level position", async () => {
    const s = session([element(100, 50, 300, 200, U1)], [inner()]);
    await executeAction(s, { type: "click", selector: "#b", frame: 0 }, 10_000);
    expect(s.driver.move).toHaveBeenLastCalledWith({ x: 160, y: 100 });
    expect(s.driver.click).toHaveBeenLastCalledWith({ x: 160, y: 100 }, { button: "left", clickCount: 1 });
  });

  it("refuses frame on actions that act on the whole page", async () => {
    const s = session([], []);
    await expect(executeAction(s, { type: "press", key: "Enter", frame: 0 } as never, 10_000)).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
      message: expect.stringContaining("不接受 frame"),
    });
    await expect(executeAction(s, { type: "click", frame: "abc" } as never, 10_000)).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
    });
  });

  it("extract and assert read from the frame and shift rects to top-level coordinates", async () => {
    const inner = frame({
      url: U1,
      content: { selector: "#b", mode: "rect", count: 1, matches: [{ rect: { x: 60, y: 50, left: 20, top: 30, width: 80, height: 40 } }], truncated: false },
    });
    // extract 的页面脚本不是按选择器分支的：让这个框架对内容脚本返回同一份结果
    inner.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes("const sections =")) return { url: U1, title: "", frames: [] };
      if (script.includes("return { selector, mode, count: total")) {
        return { selector: "#b", mode: "rect", frame: 0, count: 1, truncated: false, matches: [{ selector: "#b", tag: "button", visible: true, rect: { x: 160, y: 100, left: 120, top: 80, width: 80, height: 40 } }] };
      }
      return null;
    });
    const s = session([element(100, 50, 300, 200, U1)], [inner]);

    const result = await extractElements(s, { selector: "#b", mode: "rect", frame: 0 });

    expect(result.frame).toBe(0);
    // 坐标换算发生在页面脚本里（脚本内联了 offset）：发进 iframe 的脚本带着偏移量
    const sent = inner.executeJavaScript.mock.calls.map(([script]) => String(script)).join("\n");
    expect(sent).toContain("+ 100");
    expect(sent).toContain("+ 50");
    // 顶层页面只被读了一次 iframe 元素列表，提取本身没有碰它
    expect(s.driver.evaluate).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('querySelectorAll("iframe")'));
  });
});

describe("snapshot with iframes", () => {
  it("lists frames with their boxes and nests each frame's content", async () => {
    const grand = frame({ url: U3, content: { text: "grand text" } });
    const first = frame({ url: U1, elements: [element(40, 120, 100, 60, U3)], children: [grand], content: { text: "first text" } });
    const s = session([element(100, 50, 300, 200, U1)], [first]);
    (s.driver.evaluate as ReturnType<typeof vi.fn>).mockImplementation(async (script: string) => {
      if (script.includes('querySelectorAll("iframe")')) return [element(100, 50, 300, 200, U1)];
      return { url: "http://top/", title: "top", text: "top text", frames: [], links: [], buttons: [], inputs: [], text_length: 8 };
    });

    const snapshot = await snapshotPage(s, { frame_depth: 2 });

    expect(snapshot.frames.map((item) => [item.index, item.parent, item.url, item.rect, item.content?.text])).toEqual([
      [0, null, U1, { left: 100, top: 50, width: 300, height: 200 }, "first text"],
      [1, 0, U3, { left: 140, top: 170, width: 100, height: 60 }, "grand text"],
    ]);
    // 嵌套内容里的 frames 是同一套编号的子框架列表
    expect(snapshot.frames[0].content?.frames).toEqual([
      { index: 1, parent: 0, url: U3, name: "", rect: { left: 140, top: 170, width: 100, height: 60 } },
    ]);
    expect(snapshot).not.toHaveProperty("frames_truncated");
  });

  it("stops at the depth and count limits and marks what it skipped", async () => {
    const children = [frame({ url: U1, content: {} }), frame({ url: U2, content: {} })];
    const s = session([element(0, 0, 10, 10, U1), element(0, 0, 10, 10, U2)], children);

    const listed = await snapshotPage(s, { frame_depth: 0 });
    expect(listed.frames.map((item) => item.url)).toEqual([U1, U2]);
    expect(listed.frames.every((item) => item.content === undefined)).toBe(true);

    const capped = await snapshotPage(s, { max_frames: 1 });
    expect(capped.frames[0].content).toBeDefined();
    expect(capped.frames[1].content).toBeUndefined();
    expect(capped.frames_truncated).toBe(true);
  });

  it("keeps the rest of the snapshot when a frame's content cannot be read or the list is in flux", async () => {
    const broken = frame({ url: U1, failWith: "boom" });
    const s = session([element(0, 0, 10, 10, U1)], [broken]);
    const snapshot = await snapshotPage(s);
    expect(snapshot.frames[0]).toMatchObject({ url: U1, content_error: "boom" });
    expect(snapshot.frames[0].content).toBeUndefined();

    const shifting = session([element(0, 0, 10, 10, U1)], [broken, broken]);
    const unstable = await snapshotPage(shifting, {});
    expect(unstable.frames).toEqual([]);
    expect(unstable.frames_error).toContain("正在变化");
  });

  it("declares frame targeting on the tools that accept it", () => {
    const framed = ["click", "fill", "hover", "select", "focus", "scroll", "scroll_into_view", "wait_for", "upload_file", "extract", "assert"];
    for (const name of framed) {
      const tool = MALO_TOOLS.find((item) => item.name === name)!;
      expect(tool.input_schema.properties, name).toHaveProperty("frame");
      expect(tool.input_schema.properties, name).toHaveProperty("frame_url");
    }
    for (const name of ["press", "type", "drag", "history", "sleep"]) {
      expect(MALO_TOOLS.find((item) => item.name === name)!.input_schema.properties).not.toHaveProperty("frame");
    }
  });
});

describe("file upload inside an iframe", () => {
  function uploadSession(inner: FakeFrame, objectId?: string, exceptionDetails?: unknown) {
    const s = session([element(100, 50, 300, 200, U1)], [inner]);
    const send = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "Runtime.evaluate") {
        return { result: objectId ? { objectId } : {}, exceptionDetails };
      }
      return {};
    });
    (s.driver as unknown as { send: typeof send }).send = send;
    return { session: s, send };
  }

  it("reaches the input through the same-origin frame document and releases the object handle", async () => {
    const { session: s, send } = uploadSession(frame({ url: U1 }), "object-1");

    const detail = await executeAction(
      s,
      { type: "upload_file", selector: "#f", files: ["/tmp/a.txt"], frame: 0 },
      10_000,
    );

    expect(detail).toBe("uploaded 1 file(s) to #f in iframe 0");
    const expression = send.mock.calls.find(([method]) => method === "Runtime.evaluate")?.[1].expression;
    expect(expression).toBe('document.querySelectorAll("iframe")[0].contentDocument.querySelector("#f")');
    expect(send).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      objectId: "object-1",
      files: ["/tmp/a.txt"],
    });
    expect(send).toHaveBeenCalledWith("Runtime.releaseObjectGroup", { objectGroup: "malo-upload" });
  });

  it("refuses a cross-origin frame with a reason instead of silently doing nothing", async () => {
    // 跨域时表达式抛 TypeError，返回里带着异常和一个指向错误对象的句柄
    const { session: s, send } = uploadSession(frame({ url: U1 }), "error-object", { text: "TypeError" });

    await expect(
      executeAction(s, { type: "upload_file", selector: "#f", files: ["/tmp/a.txt"], frame: 0 }, 10_000),
    ).rejects.toMatchObject({ code: "E_UNSUPPORTED", message: expect.stringContaining("跨域") });
    expect(send.mock.calls.map(([method]) => method)).not.toContain("DOM.setFileInputFiles");
  });
});
