export type LeaseKeepInput = {
  /** 租约上正在处理中的请求数。 */
  inflight: number;
  /** 名下窗口正显示给人的会话数。 */
  visibleSessions: number;
  /** 自上次真实活动（请求或心跳）以来过了多久。 */
  silentForMs: number;
  /** 可见窗口的宽限：这么久没有任何活动，即使窗口还开着也照常回收。0 = 不宽限。 */
  visibleGraceMs: number;
};

/**
 * 租约到期时该不该续一期：有请求在跑说明客户端活着在等结果；窗口显示给人看时人还在登录、
 * 核对，5 分钟没发请求是常态——但只宽限一段时间，免得客户端已经死了、窗口被人遗忘，
 * 租约和会话就永远收不回来。
 */
export function shouldKeepLease(input: LeaseKeepInput): boolean {
  if (input.inflight > 0) return true;
  return (
    input.visibleSessions > 0 &&
    input.visibleGraceMs > 0 &&
    input.silentForMs <= input.visibleGraceMs
  );
}
