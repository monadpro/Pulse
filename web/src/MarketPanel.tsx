import { fmtN } from "./format";
import type { BatchRow, Stats } from "./useBatches";

/** Market view from on-chain data (shared batch poll). Clicking a row opens that block's detail. */
export function MarketPanel({ rows, stats, error, loaded, onSelect }: { rows: BatchRow[]; stats?: Stats; error: string; loaded: boolean; onSelect: (block: number) => void }) {
  // only batches that actually traded have a meaningful price
  const traded = rows.filter((r) => r.settled && r.volume > 0);
  const last = traded[0];
  const prev = traded[1];
  const series = [...traded].reverse().map((r) => r.price);
  const change = last && prev ? last.price - prev.price : 0;

  return (
    <section>
      <h2>行情 <small>来自链上的清算结果，每个区块一个价格 · 点击一行查看区块详情</small></h2>
      {error && <p className="warn-inline">{error}</p>}
      {stats && (
        <p className="muted">
          累计订单 <b>{stats.orders.toLocaleString()}</b> · 已清算批次 <b>{stats.settled.toLocaleString()}</b> · 历史单区块最多{" "}
          <b className="buy">{stats.maxBatch.toLocaleString()}</b> 笔订单{stats.maxBlock ? <>（区块 <a onClick={() => onSelect(stats.maxBlock)} title="点击查看这个区块">{stats.maxBlock}</a>）</> : ""}
        </p>
      )}
      {!loaded ? (
        <p className="muted">{error ? "暂时无法加载。" : "正在读取链上数据…"}</p>
      ) : !last ? (
        <p className="muted">还没有成交记录。下单并清算之后，这里会显示最近的清算价和走势。</p>
      ) : (
        <div className="market">
          <div>
            <div className="muted">最近清算价（区块 {last.batch}）</div>
            <div className="bigprice">
              {last.price.toFixed(2)} <small>pUSD</small>
              {prev && (
                <span className={change > 0 ? "buy" : change < 0 ? "sell" : ""}>
                  {change > 0 ? " ▲" : change < 0 ? " ▼" : " –"} {Math.abs(change).toFixed(2)}
                </span>
              )}
            </div>
            <div className="muted">成交量 {fmtN(last.volume)} pMON</div>
          </div>
          <Spark series={series} />
        </div>
      )}
      {rows.length > 0 && (
        <table className="clickable">
          <thead>
            <tr><th>区块</th><th>订单</th><th>状态</th><th>清算价</th><th>成交量</th><th>买盘</th><th>卖盘</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((r) => (
              <tr key={r.batch} onClick={() => onSelect(r.batch)} title="点击查看区块详情">
                <td>{r.batch}</td>
                <td>{r.orders}</td>
                <td>{r.settled ? "已清算" : "待清算"}</td>
                <td>{r.settled ? (r.volume > 0 ? r.price.toFixed(2) : <span title="本批次买卖价格未匹配，没有成交">无成交</span>) : "–"}</td>
                <td>{r.settled ? fmtN(r.volume) : "–"}</td>
                <td className="buy">{fmtN(r.bids)}</td>
                <td className="sell">{fmtN(r.asks)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Spark({ series }: { series: number[] }) {
  if (series.length < 2) return <div className="muted spark">再有一批成交后显示走势</div>;
  const w = 320, h = 70, pad = 6;
  const min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 0.01;
  const pts = series.map((p, i) => `${pad + (i * (w - 2 * pad)) / (series.length - 1)},${h - pad - ((p - min) / span) * (h - 2 * pad)}`);
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h}>
      <polyline points={pts.join(" ")} fill="none" stroke="#46d39a" strokeWidth="2" />
      {pts.map((p, i) => <circle key={i} cx={p.split(",")[0]} cy={p.split(",")[1]} r="3" fill="#46d39a" />)}
    </svg>
  );
}
