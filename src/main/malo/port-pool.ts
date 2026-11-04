export class PortPool {
  private readonly used = new Set<number>();
  private readonly blocked = new Set<number>();

  constructor(
    readonly min: number,
    readonly max: number,
  ) {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new Error("端口池边界必须是整数");
    }
    if (min < 1 || max > 65535 || min > max) {
      throw new Error(`无效端口池范围：${min}-${max}`);
    }
  }

  acquire(): number | null {
    for (let port = this.min; port <= this.max; port += 1) {
      if (this.used.has(port) || this.blocked.has(port)) continue;
      this.used.add(port);
      return port;
    }
    return null;
  }

  release(port: number): void {
    this.used.delete(port);
  }

  block(port: number): void {
    this.used.delete(port);
    this.blocked.add(port);
  }

  snapshot(): { min: number; max: number; used: number[]; blocked: number[] } {
    return {
      min: this.min,
      max: this.max,
      used: [...this.used].sort((a, b) => a - b),
      blocked: [...this.blocked].sort((a, b) => a - b),
    };
  }
}
