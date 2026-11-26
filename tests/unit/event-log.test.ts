import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/main/malo/event-log";

const tmpDirs: string[] = [];

async function logFile(name = "events.jsonl"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "malo-event-log-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

const lines = async (file: string) =>
  (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("EventLog", () => {
  it("pages through the ring and tells the reader how much it missed", () => {
    const log = new EventLog("/unused/events.jsonl", 5);
    for (let index = 0; index < 7; index += 1) log.record(`e${index + 1}`);

    const page = log.after(0, 100);
    expect(page.events.map((event) => event.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(page.next_after).toBe(7);
    expect(page.dropped).toBe(2);
    expect(log.after(7, 100)).toEqual({ events: [], next_after: 7, dropped: 0 });
    expect(log.after(3, 2)).toMatchObject({ next_after: 5, dropped: 0 });
    expect(log.after(3, 2).events.map((event) => event.seq)).toEqual([4, 5]);
  });

  it("appends every event as one JSON line and flushes on demand", async () => {
    const file = await logFile();
    const log = new EventLog(file);
    log.record("session.created", { name: "work" });
    log.record("page.loaded");
    await log.flush();

    const written = await lines(file);
    expect(written.map((event) => [event.seq, event.type])).toEqual([
      [1, "session.created"],
      [2, "page.loaded"],
    ]);
    expect(written[0].detail).toEqual({ name: "work" });
    expect(typeof written[0].at).toBe("string");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("marks the file truncated once it reaches the size cap instead of growing forever", async () => {
    const file = await logFile();
    const log = new EventLog(file, 200, 300);
    for (let index = 0; index < 30; index += 1) log.record("noisy.event", { pad: "x".repeat(20) });
    await log.flush();

    const written = await lines(file);
    expect(written.length).toBeLessThan(30);
    expect(written[written.length - 1]).toMatchObject({ type: "event_log.truncated" });
    expect(written.filter((event) => event.type === "event_log.truncated")).toHaveLength(1);
    // 文件停了，内存里的环形缓冲照常可用
    expect(log.after(0, 100).events).toHaveLength(30);
  });

  it("keeps serving events when the file cannot be written", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "malo-event-log-"));
    tmpDirs.push(dir);
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = new EventLog(path.join(blocker, "events.jsonl"));

    expect(log.record("page.loaded")).toMatchObject({ seq: 1, type: "page.loaded" });
    log.record("page.loaded");
    await log.flush();

    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0][0])).toContain("事件落盘失败");
    expect(log.after(0, 10).events).toHaveLength(2);
  });

  it("rejects limits that are not positive integers", () => {
    expect(() => new EventLog("/unused/events.jsonl", 0)).toThrow(/正整数/);
    expect(() => new EventLog("/unused/events.jsonl", 10, 0)).toThrow(/正整数/);
  });
});
