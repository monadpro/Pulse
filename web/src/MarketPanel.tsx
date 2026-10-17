import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { addrs, deployed, readMany } from "./chainClients";
import { exchangeAbi } from "./abi";

interface Row {
  batch: number;
  orders: number;
  settled: boolean;
  price: number; // clearing price (settled batches)
  volume: number; // matched pMON
  bids: number; // total buy size
  asks: number; // total sell size
}
interface Stats {
  orders: number;
  settled: number;
  maxBatch: number;
  maxBlock: number;
}

const PRICE_AT = (tick: number) => 0.5 + tick * 0.01;
const n18 = (v: bigint) => Number(formatEther(v));
const fmtN = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * Market view built only from on-chain data: the latest clearing prices and the recent batches.
 * The contract indexes batches itself (recentBatches), so one multicall request per poll is enough,
 * which keeps us under the public RPC's ~15 requests/sec no matter how many orders there are.
 */
export function MarketPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState<Stats>();
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!deployed) return;
    let stop = false;
    const load = async () => {
      try {
        const [recent, orders, settled, maxBatch, maxBlock] = await readMany([
          { address: addrs.exchange, abi: exchangeAbi, functionName: "recentBatches", args: [24n] },
          { address: addrs.exchange, abi: exchangeAbi, functionName: "ordersLength" },
          { address: addrs.exchange, abi: exchangeAbi, functionName: "settledBatchCount" },
          { address: addrs.exchange, abi: exchangeAbi, functionName: "maxBatchOrders" },
          { address: addrs.exchange, abi: exchangeAbi, functionName: "maxBatchBlock" },
        ]);
        if (stop) return;
        setRows(
          (recent as any[]).map((r) => ({
            batch: Number(r.batch),
            orders: r.orderCount,
            settled: r.settled,
            price: PRICE_AT(r.clearTick),
            volume: n18(r.volume),
            bids: n18(r.totalBids),
            asks: n18(r.totalAsks),
          })),
        );
        setStats({ orders: Number(orders), settled: Number(settled), maxBatch: Number(maxBatch), maxBlock: Number(maxBlock) });
        setErr("");
      } catch (e: any) {
        if (!stop) setErr(`行情读取失败，稍后自动重试：${e?.shortMessage ?? e?.message ?? e}`);
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  // only batches that actually traded have a meaningful price
  const traded = rows.filter((r) => r.settled && r.volume > 0);
  const last = traded[0];
  const prev = traded[1];
  const series = [...traded].reverse().map((r) => r.price);
  const change = last && prev ? last.price - prev.price : 0;

  return (
    <section>
      <h2>行情 <small>来自链上的清算结果，每个区块一个价格</small></h2>
      {err && <p className="warn-inline">{err}</p>}
      {stats && (
        <p className="muted">
          累计订单 <b>{stats.orders.toLocaleString()}</b> · 已清算批次 <b>{stats.settled.toLocaleString()}</b> · 历史单区块最多{" "}
          <b className="buy">{stats.maxBatch.toLocaleString()}</b> 笔订单{stats.maxBlock ? `（区块 ${stats.maxBlock}）` : ""}
        </p>
      )}
      {!last ? (
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
        <table>
          <thead>
            <tr><th>区块</th><th>订单</th><th>状态</th><th>清算价</th><th>成交量</th><th>买盘</th><th>卖盘</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((r) => (
              <tr key={r.batch}>
                <td>{r.batch}</td>
                <td>{r.orders}</td>
                <td>{r.settled ? "已清算" : "待清算"}</td>
                <td>{r.settled && r.volume > 0 ? r.price.toFixed(2) : "–"}</td>
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
