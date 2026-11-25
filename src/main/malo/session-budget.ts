import { DemoError } from "../../shared/errors";

/** daemon 全局的会话名额：每个会话是一个窗口加渲染进程，总量必须有上限。 */
export class SessionBudget {
  private used = 0;

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max <= 0) {
      throw new Error(`会话总上限必须是正整数：${max}`);
    }
  }

  reserve(): void {
    if (this.used >= this.max) {
      throw new DemoError(
        "E_RESOURCE_LIMIT",
        `malo daemon 会话总数已达上限 ${this.max}（--max-sessions-total）`,
      );
    }
    this.used += 1;
  }

  release(): void {
    this.used -= 1;
  }

  get count(): number {
    return this.used;
  }
}
