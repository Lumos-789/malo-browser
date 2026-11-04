import { useEffect, useMemo, useState } from "react";

type Order = {
  id: number;
  code: string;
  name: string;
  region: string;
  amount: string;
  status: string;
  risk: boolean;
};

const ORDERS: Order[] = [
  { id: 1, code: "SO-2026-1041", name: "华东渠道首批铺货", region: "上海", amount: "¥182,400", status: "已发货", risk: false },
  { id: 2, code: "SO-2026-1042", name: "华南渠道补单", region: "广州", amount: "¥96,800", status: "待复核", risk: false },
  { id: 3, code: "SO-2026-1043", name: "风险订单 · 金额异常", region: "深圳", amount: "¥1,204,000", status: "挂起", risk: true },
  { id: 4, code: "SO-2026-1044", name: "西北渠道常规订单", region: "西安", amount: "¥64,200", status: "已复核", risk: false },
];

export default function App() {
  const frozen = new URLSearchParams(window.location.search).get("compare") === "1";
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState(0);
  const [query, setQuery] = useState("");
  const [clock, setClock] = useState(frozen ? "10:00:00" : "--:--:--");

  useEffect(() => {
    setReady(true);
    if (frozen) return;
    const tick = window.setInterval(() => {
      setClock(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    }, 500);
    return () => window.clearInterval(tick);
  }, [frozen]);

  const rows = useMemo(() => {
    const key = query.trim();
    if (!key) return ORDERS;
    return ORDERS.filter((o) => o.name.includes(key) || o.status.includes(key) || o.code.includes(key));
  }, [query]);

  return (
    <div className={frozen ? "page frozen" : "page"} data-demo-state={ready ? "ready" : "loading"}>
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <span>信审复核台</span>
          <span className="env">演示环境</span>
        </div>
        <div className="session">
          <span>演示账号 demo@internal</span>
          <span className="clock">{clock}</span>
        </div>
      </header>

      <main className="content">
        <section className="metrics">
          <article>
            <h3>待复核</h3>
            <strong>18</strong>
            <span>较昨日 +4</span>
          </article>
          <article>
            <h3>风险命中</h3>
            <strong className="warn">3</strong>
            <span>需人工介入</span>
          </article>
          <article>
            <h3>今日完成</h3>
            <strong data-demo-id="review-count">{count}</strong>
            <span>本次演示标记</span>
          </article>
          <article>
            <h3>平均处理时长</h3>
            <strong>2m 14s</strong>
            <span>近 30 天</span>
          </article>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>订单队列</h2>
            <div className="tools">
              <input
                data-demo-id="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索订单或状态"
                aria-label="搜索订单"
              />
              <button data-demo-id="increment" onClick={() => setCount((v) => v + 1)} type="button">
                标记已复核
              </button>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>订单号</th>
                <th>名称</th>
                <th>区域</th>
                <th>金额</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((order) => (
                <tr key={order.id} data-demo-id={`row-${order.id}`} className={order.risk ? "risk" : ""}>
                  <td className="mono">{order.code}</td>
                  <td>{order.name}</td>
                  <td>{order.region}</td>
                  <td className="mono">{order.amount}</td>
                  <td>
                    <span className={`tag ${order.risk ? "tag-risk" : ""}`}>{order.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="progress">
            <div className="bar" />
          </div>
        </section>
      </main>
    </div>
  );
}
