import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { addrs, publicHttp } from "./chainClients";
import { exchangeAbi } from "./abi";
import { explorer, fmt, tickPrice, type MyOrder } from "./format";
import { orderSubmitted } from "./BlockDetail";
import type { BatchRow } from "./useBatches";

/** Expanded view of one of my orders: lifecycle steps plus limit price -> clearing price -> fill -> payout. */
export function OrderDetail({ o, row, head }: { o: MyOrder; row?: BatchRow; head: number }) {
  const [clear, setClear] = useState<{ tick: number; volume: bigint; bids: bigint; asks: bigint }>();
  const [hash, setHash] = useState<Hex>();
  const [hashErr, setHashErr] = useState("");

  useEffect(() => {
    let stop = false;
    // the transaction that created this order (one block only, within the RPC's log range limit)
    publicHttp
      .getLogs({ address: addrs.exchange, event: orderSubmitted, args: { orderId: BigInt(o.id) }, fromBlock: BigInt(o.batch), toBlock: BigInt(o.batch) })
      .then((l) => {
        if (stop) return;
        if (l[0]) setHash(l[0].transactionHash as Hex);
        else setHashErr("没有找到这笔订单的下单记录");
      })
      .catch((e) => !stop && setHashErr(`暂时无法读取（${e?.shortMessage ?? e?.message ?? e}）`));
    if (o.settled && !row) {
      publicHttp
        .readContract({ address: addrs.exchange, abi: exchangeAbi, functionName: "getBatch", args: [BigInt(o.batch)] })
        .then((r: any) => !stop && setClear({ tick: r[1], volume: r[2], bids: (r[3] as bigint[]).reduce((a, b) => a + b, 0n), asks: (r[4] as bigint[]).reduce((a, b) => a + b, 0n) }))
        .catch(() => {});
    }
    return () => {
      stop = true;
    };
  }, [o.id, o.batch, o.settled, !!row]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasPrice = o.settled && (row ? row.volume > 0 : clear ? clear.volume > 0n : false);
  const clearTick = row ? row.clearTick : clear?.tick ?? 0;
  const closed = head > o.batch;
  // why nothing traded: say what the batch actually looked like, not just "prices did not match"
  const hasBids = row ? row.bids > 0 : clear ? clear.bids > 0n : true;
  const hasAsks = row ? row.asks > 0 : clear ? clear.asks > 0n : true;
  const noFillReason = !hasAsks ? "本批次只有买单，没有卖家" : !hasBids ? "本批次只有卖单，没有买家" : "本批次买卖价格未匹配";
  const buy = o.side === 0;

  return (
    <div className="order-detail">
      <div className="steps">
        <span className="step done">● 进入区块 {o.batch}</span>
        <span className={`step ${o.settled ? "done" : ""}`}>{o.settled ? "●" : "○"} 批次清算</span>
        <span className={`step ${o.claimed ? "done" : ""}`}>{o.claimed ? "●" : "○"} 领取</span>
      </div>
      <ul>
        <li>你的{buy ? "最高买价" : "最低卖价"}：<b>{tickPrice(o.tick).toFixed(2)}</b> pUSD，数量 <b>{fmt(o.amount)}</b> pMON</li>
        <li>
          统一清算价：
          <b>{!o.settled ? (closed ? "待清算" : "区块进行中") : hasPrice ? `${tickPrice(clearTick).toFixed(2)} pUSD` : `无成交（${noFillReason}）`}</b>
        </li>
        {o.settled && (
          <>
            <li>成交数量：<b>{o.filled > 0n ? `${fmt(o.filled)} pMON` : "未成交"}</b></li>
            <li>
              {o.claimed ? "已到账：" : "可领取："}
              {buy ? (
                <>买到 <b>{fmt(o.baseOut)}</b> pMON，退回 <b>{fmt(o.quoteOut)}</b> pUSD</>
              ) : (
                <>卖得 <b>{fmt(o.quoteOut)}</b> pUSD，退回未卖出的 <b>{fmt(o.baseOut)}</b> pMON</>
              )}
            </li>
          </>
        )}
        {!o.settled && <li className="muted">清算后这里会显示成交数量、到账和退款。</li>}
        <li>
          {hash ? (explorer ? <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">查看下单交易</a> : `下单交易：${hash.slice(0, 12)}…`) : hashErr ? `下单交易：${hashErr}` : "下单交易：读取中…"}
          {explorer && <> · <a href={`${explorer}/block/${o.batch}`} target="_blank" rel="noreferrer">查看区块</a></>}
        </li>
      </ul>
    </div>
  );
}
