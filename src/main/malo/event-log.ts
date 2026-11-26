import { appendFile } from "node:fs/promises";
import type { MaloEventsPage, MaloSessionEvent } from "../../shared/malo";

const RING_LIMIT = 200;
const FILE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 会话事件留两份：内存里一份环形缓冲供 agent 轮询，artifacts/events.jsonl 里一份追加供事后审计。
 * 环形缓冲被覆盖时轮询方能从 dropped 知道自己漏了多少条；文件写满后只补一条截断标记，不再无界增长。
 */
export class EventLog {
  private seq = 0;
  private readonly events: MaloSessionEvent[] = [];
  private bytes = 0;
  private fileClosed = false;
  private truncationMarked = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly ringLimit = RING_LIMIT,
    private readonly fileMaxBytes = FILE_MAX_BYTES,
  ) {
    if (!Number.isInteger(ringLimit) || ringLimit < 1) {
      throw new Error(`事件环形缓冲上限必须是正整数：${ringLimit}`);
    }
    if (!Number.isInteger(fileMaxBytes) || fileMaxBytes < 1) {
      throw new Error(`事件文件上限必须是正整数：${fileMaxBytes}`);
    }
  }

  record(type: string, detail?: Record<string, unknown>): MaloSessionEvent {
    const event: MaloSessionEvent = { seq: (this.seq += 1), at: new Date().toISOString(), type, detail };
    this.events.push(event);
    if (this.events.length > this.ringLimit) {
      this.events.splice(0, this.events.length - this.ringLimit);
    }
    if (!this.fileClosed) {
      this.persist(event);
    } else if (!this.truncationMarked) {
      // 文件写满：补一条截断标记，读的人才知道后面的没留档
      this.truncationMarked = true;
      this.persist({ ...event, type: "event_log.truncated", detail: { after_seq: event.seq } });
    }
    return event;
  }

  after(cursor: number, limit: number): MaloEventsPage {
    const bounded = Math.max(1, Math.min(this.ringLimit, Math.floor(limit)));
    const page = this.events.filter((event) => event.seq > cursor).slice(0, bounded);
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    return {
      events: page,
      next_after: page[page.length - 1]?.seq ?? cursor,
      dropped: Math.max(0, oldest - 1 - Math.max(cursor, 0)),
    };
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private persist(event: MaloSessionEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > this.fileMaxBytes) this.fileClosed = true;
    this.chain = this.chain.then(async () => {
      try {
        await appendFile(this.file, line, { mode: 0o600 });
      } catch (error) {
        // 落盘失败不能打断会话（事件来自页面回调）；喊一次就停，免得每个事件刷一条
        if (!this.fileClosed) {
          this.fileClosed = true;
          console.error(`[malo] 事件落盘失败，${this.file} 不再追加：${(error as Error).message}`);
        }
      }
    });
  }
}
