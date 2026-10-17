import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther } from "viem";
import { addrs, deployed, readMany } from "./chainClients";
import { exchangeAbi } from "./abi";
import { tickPrice } from "./format";

export interface BatchRow {
  batch: number;
  orders: number;
  settled: boolean;
  clearTick: number;
  price: number; // clearing price, meaningful only when volume > 0
  volume: number; // matched pMON
  bids: number; // total buy size
  asks: number; // total sell size
}
export interface Stats {
  orders: number;
  settled: number;
  maxBatch: number;
  maxBlock: number;
}

const n18 = (v: bigint) => Number(formatEther(v));

/**
 * The contract indexes its own batches (recentBatches), so one multicall per poll restores the recent history
 * after a page refresh without any eth_getLogs scan (the public RPC limits logs to 100 blocks).
 * `loaded` stays false until the first successful read: callers must not show "0 orders" before that.
 */
export function useBatches() {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [stats, setStats] = useState<Stats>();
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const busy = useRef(false);

  const reload = useCallback(async () => {
    if (!deployed || busy.current) return;
    busy.current = true;
    try {
      const [recent, orders, settled, maxBatch, maxBlock] = await readMany([
        { address: addrs.exchange, abi: exchangeAbi, functionName: "recentBatches", args: [48n] },
        { address: addrs.exchange, abi: exchangeAbi, functionName: "ordersLength" },
        { address: addrs.exchange, abi: exchangeAbi, functionName: "settledBatchCount" },
        { address: addrs.exchange, abi: exchangeAbi, functionName: "maxBatchOrders" },
        { address: addrs.exchange, abi: exchangeAbi, functionName: "maxBatchBlock" },
      ]);
      setRows(
        (recent as any[]).map((r) => ({
          batch: Number(r.batch),
          orders: r.orderCount,
          settled: r.settled,
          clearTick: r.clearTick,
          price: tickPrice(r.clearTick),
          volume: n18(r.volume),
          bids: n18(r.totalBids),
          asks: n18(r.totalAsks),
        })),
      );
      setStats({ orders: Number(orders), settled: Number(settled), maxBatch: Number(maxBatch), maxBlock: Number(maxBlock) });
      setError("");
      setLoaded(true);
    } catch (e: any) {
      setError(`历史批次暂时无法加载（${e?.shortMessage ?? e?.message ?? e}），稍后自动重试`);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);

  return { rows, stats, error, loaded, reload };
}
