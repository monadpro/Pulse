import { useEffect, useState } from "react";
import { parseAbiItem, type Address, type Hex } from "viem";
import { addrs, publicHttp, readMany } from "./chainClients";
import { exchangeAbi } from "./abi";
import { BatchLens } from "./BatchLens";
import { derivedState, explorer, fmtN, STATE_INFO, tickPrice, type CommitState } from "./format";
import type { BatchRow } from "./useBatches";

export const orderSubmitted = parseAbiItem(
  "event OrderSubmitted(uint256 indexed orderId, uint64 indexed batch, address indexed owner, uint8 side, uint8 tick, uint128 amount)",
);

interface Book {
  settled: boolean;
  clearTick: number;
  volume: number;
  bids: number[];
  asks: number[];
}
interface LogRow {
  id: number;
  owner: Address;
  side: number;
  tick: number;
  amount: number;
  hash: Hex;
}

const MAX_ORDERS = 30;
const e18 = 1e18;

/** What happened in this batch, in plain words. Never invents numbers: it only reads the book the chain returned. */
function explain(book: Book, block: number, head: number): string {
  const hasBid = book.bids.some((v) => v > 0);
  const hasAsk = book.asks.some((v) => v > 0);
  if (!hasBid && !hasAsk) return "这个区块没有订单。";
  if (!book.settled) {
    return block >= head
      ? "这个区块还在进行中，订单仍在进入。区块结束后，这批订单会一起按统一价清算。"
      : "这个区块已经结束，但这一批还没有清算。清算由自动清算脚本或任何人触发；清算前所有押金都安全地留在合约里。";
  }
  if (book.volume > 0) {
    return `本批次统一清算价 ${tickPrice(book.clearTick).toFixed(2)} pUSD：出价不低于它的买单、报价不高于它的卖单，按这个价格成交，共成交 ${fmtN(book.volume)} pMON。其余订单没有成交，押金退回。`;
  }
  const bestBid = hasBid ? Math.max(...book.bids.map((v, i) => (v > 0 ? i : -1))) : -1;
  const bestAsk = hasAsk ? Math.min(...book.asks.map((v, i) => (v > 0 ? i : 99))) : -1;
  const detail =
    !hasBid ? "这一批只有卖单，没有买家。" : !hasAsk ? "这一批只有买单，没有卖家。" : `最高买价 ${tickPrice(bestBid).toFixed(2)} 低于最低卖价 ${tickPrice(bestAsk).toFixed(2)}。`;
  return `本批次已完成清算，但买卖价格未匹配，因此没有成交。${detail}所有订单的押金都可以全额领回。`;
}

export function BlockDetail({ block, head, real, row, onClose }: { block: number; head: number; real?: CommitState; row?: BatchRow; onClose: () => void }) {
  const [book, setBook] = useState<Book>();
  const [bookErr, setBookErr] = useState("");
  const [logs, setLogs] = useState<LogRow[]>();
  const [logErr, setLogErr] = useState("");
  const [fills, setFills] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    let stop = false;
    setBook(undefined);
    setLogs(undefined);
    setBookErr("");
    setLogErr("");
    setFills(new Map());

    const load = async () => {
      try {
        const r = (await publicHttp.readContract({ address: addrs.exchange, abi: exchangeAbi, functionName: "getBatch", args: [BigInt(block)] })) as any;
        if (stop) return;
        setBook({ settled: r[0], clearTick: r[1], volume: Number(r[2]) / e18, bids: (r[3] as bigint[]).map((v) => Number(v) / e18), asks: (r[4] as bigint[]).map((v) => Number(v) / e18) });
        setBookErr("");
      } catch (e: any) {
        if (!stop) setBookErr(`暂时无法加载这个区块的链上数据：${e?.shortMessage ?? e?.message ?? e}`);
      }
      try {
        // one block only: well inside the public RPC's 100-block eth_getLogs limit
        const found = await publicHttp.getLogs({ address: addrs.exchange, event: orderSubmitted, args: { batch: BigInt(block) }, fromBlock: BigInt(block), toBlock: BigInt(block) });
        if (stop) return;
        setLogs(
          found
            .map((l) => ({ id: Number(l.args.orderId), owner: l.args.owner as Address, side: Number(l.args.side), tick: Number(l.args.tick), amount: Number(l.args.amount) / e18, hash: l.transactionHash as Hex }))
            .sort((a, b) => a.id - b.id),
        );
        setLogErr("");
      } catch (e: any) {
        if (!stop) setLogErr(`暂时无法加载订单明细：${e?.shortMessage ?? e?.message ?? e}`);
      }
    };
    load();
    // keep refreshing while the batch can still change (open, or not cleared yet)
    const t = setInterval(() => (!book?.settled ? load() : undefined), 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [block]); // eslint-disable-line react-hooks/exhaustive-deps

  // after clearing, learn how much each listed order actually filled
  useEffect(() => {
    if (!book?.settled || !logs || logs.length === 0) return;
    let stop = false;
    readMany(logs.slice(0, MAX_ORDERS).map((l) => ({ address: addrs.exchange, abi: exchangeAbi, functionName: "previewClaim", args: [BigInt(l.id)] })))
      .then((res) => {
        if (stop) return;
        setFills(new Map(logs.slice(0, MAX_ORDERS).map((l, i) => [l.id, Number(res[i][0]) / e18])));
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [book?.settled, logs?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const settled = book?.settled ?? row?.settled ?? false;
  const state: CommitState = real ?? derivedState(block, head);
  const clearInfo = settled && book && book.volume > 0;
  const buys = logs?.filter((l) => l.side === 0).length ?? 0;
  const sells = (logs?.length ?? 0) - buys;

  return (
    <section className="detail">
      <div className="detail-head">
        <h2>
          区块 {block} 详情
          {explorer && <a className="small-link" href={`${explorer}/block/${block}`} target="_blank" rel="noreferrer">在区块浏览器打开</a>}
        </h2>
        <button onClick={onClose}>关闭</button>
      </div>

      <div className="statusrows">
        <div>
          <b>区块确认状态：</b>
          {real ? (
            <>{STATE_INFO[real].label}（节点返回的真实状态）。{STATE_INFO[real].meaning}。</>
          ) : (
            <>
              <span className="tag warn">推算</span> 页面没有收到过这个区块的真实状态，按距离估计约为「{STATE_INFO[state].label}」，仅供参考。
            </>
          )}
        </div>
        <div>
          <b>批次清算状态：</b>
          {settled ? "已清算" : block >= head ? "进行中" : "待清算"}。<span className="muted">区块被确认，不等于这一批订单已经清算，这是两件事。</span>
        </div>
      </div>

      {bookErr && <p className="warn-inline">{bookErr}</p>}
      {!book && !bookErr && <p className="muted">正在读取链上数据…</p>}
      {book && (
        <>
          <p className="explain">{explain(book, block, head)}</p>
          <div className="kpis">
            <span>买单 <b className="buy">{logs ? buys : "…"}</b> 笔</span>
            <span>卖单 <b className="sell">{logs ? sells : "…"}</b> 笔</span>
            <span>清算价 <b>{clearInfo ? tickPrice(book.clearTick).toFixed(2) : settled ? "无成交" : "待清算"}</b></span>
            <span>成交总量 <b>{settled ? fmtN(book.volume) : "–"}</b> pMON</span>
            <span>买盘总量 <b className="buy">{fmtN(book.bids.reduce((a, b) => a + b, 0))}</b></span>
            <span>卖盘总量 <b className="sell">{fmtN(book.asks.reduce((a, b) => a + b, 0))}</b></span>
            {settled && <span>未成交 <b>{fmtN(Math.max(book.bids.reduce((a, b) => a + b, 0), book.asks.reduce((a, b) => a + b, 0)) - book.volume)}</b> pMON（较大一侧）</span>}
          </div>
          {(book.bids.some((v) => v > 0) || book.asks.some((v) => v > 0)) && (
            <BatchLens bids={book.bids} asks={book.asks} clearTick={book.clearTick} showClear={!!clearInfo} />
          )}
        </>
      )}

      <h3>本区块的订单</h3>
      {logErr && <p className="warn-inline">{logErr}</p>}
      {!logs && !logErr && <p className="muted">正在读取订单…</p>}
      {logs && logs.length === 0 && <p className="muted">这个区块没有订单。</p>}
      {logs && logs.length > 0 && (
        <table>
          <thead>
            <tr><th>#</th><th>方向</th><th>限价</th><th>数量</th><th>结果</th><th>交易</th></tr>
          </thead>
          <tbody>
            {logs.slice(0, MAX_ORDERS).map((l) => {
              const eligible = book && settled && book.volume > 0 && (l.side === 0 ? l.tick >= book.clearTick : l.tick <= book.clearTick);
              const filled = fills.get(l.id);
              return (
                <tr key={l.id}>
                  <td>{l.id}</td>
                  <td className={l.side === 0 ? "buy" : "sell"}>{l.side === 0 ? "买" : "卖"}</td>
                  <td>{tickPrice(l.tick).toFixed(2)}</td>
                  <td>{fmtN(l.amount)}</td>
                  <td>
                    {!settled ? "待清算" : !book || book.volume === 0 ? "未成交（价格未匹配）" : !eligible ? "未成交（限价不满足）" : filled !== undefined ? `成交 ${fmtN(filled)}` : "符合成交条件"}
                  </td>
                  <td>{explorer ? <a href={`${explorer}/tx/${l.hash}`} target="_blank" rel="noreferrer">{l.hash.slice(0, 8)}…</a> : l.hash.slice(0, 8)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {logs && logs.length > MAX_ORDERS && <p className="muted">只显示前 {MAX_ORDERS} 笔，共 {logs.length} 笔。</p>}
    </section>
  );
}
