import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, custom, formatEther, parseEther, type Address, type Hex } from "viem";
import { chain } from "./chain";
import { addrs, deployed, publicHttp, publicWs } from "./chainClients";
import { erc20Abi, exchangeAbi, GAS } from "./abi";

type CommitState = "Proposed" | "Voted" | "Finalized";
interface Cell {
  number: number;
  state: CommitState;
  orders: number;
  clear?: { price: number; volume: number };
}
interface MyOrder {
  id: number;
  batch: number;
  tick: number;
  side: number;
  claimed: boolean;
  amount: bigint;
  settled: boolean;
}

const eth = (window as unknown as { ethereum?: any }).ethereum;
const fmt = (v: bigint) => Number(formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 2 });
const tickPrice = (t: number) => 0.5 + t * 0.01;
const MAX_CELLS = 36;

export function App() {
  const [account, setAccount] = useState<Address>();
  const [bal, setBal] = useState({ base: 0n, quote: 0n, allowBase: 0n, allowQuote: 0n });
  const [cells, setCells] = useState<Cell[]>([]);
  const [side, setSide] = useState(0);
  const [tick, setTick] = useState(50);
  const [amount, setAmount] = useState("10");
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [status, setStatus] = useState("");
  const [latency, setLatency] = useState<number>();
  const head = cells.length ? cells[cells.length - 1].number : 0;
  const headRef = useRef(0);
  headRef.current = head;

  const wallet = useMemo(
    () => (eth ? createWalletClient({ chain, transport: custom(eth) }) : undefined),
    [],
  );

  // --- live blocks: Proposed on arrival, then Voted (T+1) and Finalized (T+2); monadNewHeads overrides ---
  useEffect(() => {
    const unwatch = publicWs.watchBlocks({
      onBlock: (b) => {
        const n = Number(b.number);
        setCells((prev) => {
          if (prev.some((c) => c.number === n)) return prev;
          const next = [...prev, { number: n, state: "Proposed" as CommitState, orders: 0 }];
          return next.slice(-MAX_CELLS).map((c) => ({
            ...c,
            state: c.state === "Finalized" || n - c.number >= 2 ? "Finalized" : n - c.number === 1 ? "Voted" : c.state,
          }));
        });
      },
    });
    // Monad extension: block updates carry the real commitState.
    let stop: (() => void) | undefined;
    try {
      const sub = (publicWs.transport as any).subscribe?.({
        params: ["monadNewHeads"],
        onData: (d: any) => {
          const h = d?.result ?? d;
          const n = Number(h?.number ?? h?.header?.number);
          const s = h?.commitState as CommitState | undefined;
          if (!n || !s) return;
          setCells((prev) => prev.map((c) => (c.number === n ? { ...c, state: s } : c)));
        },
        onError: () => {},
      });
      Promise.resolve(sub)
        .then((r: any) => (stop = r?.unsubscribe))
        .catch(() => {});
    } catch {
      /* fall back to derived states */
    }
    return () => {
      unwatch();
      stop?.();
    };
  }, []);

  // --- live contract events: order counts per block and clearing results ---
  useEffect(() => {
    if (!deployed) return;
    const u1 = publicWs.watchContractEvent({
      address: addrs.exchange,
      abi: exchangeAbi,
      eventName: "OrderSubmitted",
      onLogs: (logs) =>
        setCells((prev) =>
          prev.map((c) => ({ ...c, orders: c.orders + logs.filter((l) => Number(l.args.batch) === c.number).length })),
        ),
    });
    const u2 = publicWs.watchContractEvent({
      address: addrs.exchange,
      abi: exchangeAbi,
      eventName: "BatchSettled",
      onLogs: (logs) =>
        setCells((prev) =>
          prev.map((c) => {
            const l = logs.find((x) => Number(x.args.batch) === c.number);
            return l
              ? { ...c, clear: { price: Number(formatEther(l.args.clearPrice!)), volume: Number(formatEther(l.args.volume!)) } }
              : c;
          }),
        ),
    });
    return () => {
      u1();
      u2();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!account || !deployed) return;
    const [base, quote, allowBase, allowQuote] = await Promise.all([
      publicHttp.readContract({ address: addrs.base, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      publicHttp.readContract({ address: addrs.quote, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      publicHttp.readContract({ address: addrs.base, abi: erc20Abi, functionName: "allowance", args: [account, addrs.exchange] }),
      publicHttp.readContract({ address: addrs.quote, abi: erc20Abi, functionName: "allowance", args: [account, addrs.exchange] }),
    ]);
    setBal({ base, quote, allowBase, allowQuote });

    const len = Number(await publicHttp.readContract({ address: addrs.exchange, abi: exchangeAbi, functionName: "ordersLength" }));
    const ids = Array.from({ length: Math.min(len, 40) }, (_, i) => len - 1 - i);
    const raw = await Promise.all(
      ids.map((id) =>
        publicHttp.readContract({ address: addrs.exchange, abi: exchangeAbi, functionName: "orders", args: [BigInt(id)] }),
      ),
    );
    const mine = ids
      .map((id, i) => ({ id, o: raw[i] }))
      .filter((x) => x.o[0].toLowerCase() === account.toLowerCase());
    const batches = [...new Set(mine.map((x) => x.o[1]))];
    const settledMap = new Map<bigint, boolean>();
    await Promise.all(
      batches.map(async (b) => {
        const r = await publicHttp.readContract({ address: addrs.exchange, abi: exchangeAbi, functionName: "getBatch", args: [b] });
        settledMap.set(b, r[0]);
      }),
    );
    setOrders(
      mine.map(({ id, o }) => ({
        id,
        batch: Number(o[1]),
        tick: o[2],
        side: o[3],
        claimed: o[4],
        amount: o[5],
        settled: settledMap.get(o[1]) ?? false,
      })),
    );
  }, [account]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  async function connect() {
    if (!eth || !wallet) return setStatus("未检测到钱包，请安装 MetaMask");
    const [a] = await wallet.requestAddresses();
    try {
      await wallet.switchChain({ id: chain.id });
    } catch {
      await wallet.addChain({ chain });
    }
    setAccount(a);
  }

  // Gas limits are fixed: Monad charges gas_limit, and a failed estimate can make wallets over-reserve.
  async function send(label: string, run: () => Promise<Hex>) {
    setStatus(`${label}：等待签名…`);
    try {
      const t0 = performance.now();
      const hash = await run();
      setStatus(`${label}：已提交，等待确认…`);
      const sent = performance.now();
      await publicHttp.waitForTransactionReceipt({ hash, pollingInterval: 100 });
      setLatency(Math.round(performance.now() - sent));
      setStatus(`${label}：已确认（含签名 ${Math.round(performance.now() - t0)} ms）`);
      refresh();
    } catch (e: any) {
      setStatus(`${label}失败：${e?.shortMessage ?? e?.message ?? e}`);
    }
  }

  const write = (address: Address, abi: any, functionName: string, args: any[], gas: bigint) =>
    wallet!.writeContract({ account: account!, address, abi, functionName, args, gas, chain } as any);

  const amountWei = (() => {
    try {
      return parseEther(amount || "0");
    } catch {
      return 0n;
    }
  })();
  const needQuote = (amountWei * BigInt(Math.round(tickPrice(tick) * 100))) / 100n;
  const needApprove = side === 0 ? bal.allowQuote < needQuote : bal.allowBase < amountWei;

  return (
    <div className="app">
      <header>
        <div>
          <h1>Pulse</h1>
          <p>一个区块，一个价格 · one block, one price</p>
        </div>
        <div className="wallet">
          {account ? (
            <>
              <span>{account.slice(0, 6)}…{account.slice(-4)}</span>
              <span>pMON {fmt(bal.base)}</span>
              <span>pUSD {fmt(bal.quote)}</span>
            </>
          ) : (
            <button onClick={connect}>连接钱包</button>
          )}
        </div>
      </header>

      {!deployed && <div className="warn">合约尚未部署：运行 forge script script/Deploy.s.sol，地址会写入 web/src/deployments.json</div>}

      <section>
        <h2>脉冲时间轴 <small>每格一个区块 · 黄 Proposed / 蓝 Voted / 绿 Finalized</small></h2>
        <div className="timeline">
          {cells.map((c) => (
            <div key={c.number} className={`cell ${c.state}`} title={`block ${c.number}`}>
              <b>{String(c.number).slice(-4)}</b>
              <span>{c.orders ? `${c.orders} 单` : ""}</span>
              <span>{c.clear ? `@${c.clear.price.toFixed(2)}` : ""}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="cols">
        <section>
          <h2>下单（进入当前区块的批次）</h2>
          <div className="seg">
            <button className={side === 0 ? "on buy" : ""} onClick={() => setSide(0)}>买入</button>
            <button className={side === 1 ? "on sell" : ""} onClick={() => setSide(1)}>卖出</button>
          </div>
          <label>
            {side === 0 ? "最高买价" : "最低卖价"}：<b>{tickPrice(tick).toFixed(2)} pUSD</b>
            <input type="range" min={0} max={63} value={tick} onChange={(e) => setTick(+e.target.value)} />
          </label>
          <label>
            数量 (pMON)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <div className="row">
            <button disabled={!account || !deployed} onClick={() => send("领取 pMON", () => write(addrs.base, erc20Abi, "faucet", [], GAS.faucet))}>领 pMON</button>
            <button disabled={!account || !deployed} onClick={() => send("领取 pUSD", () => write(addrs.quote, erc20Abi, "faucet", [], GAS.faucet))}>领 pUSD</button>
          </div>
          {needApprove ? (
            <button
              className="primary"
              disabled={!account || !deployed}
              onClick={() =>
                send("授权", () =>
                  write(side === 0 ? addrs.quote : addrs.base, erc20Abi, "approve", [addrs.exchange, 2n ** 256n - 1n], GAS.approve),
                )
              }
            >
              先授权 {side === 0 ? "pUSD" : "pMON"}
            </button>
          ) : (
            <button
              className="primary"
              disabled={!account || !deployed || amountWei === 0n}
              onClick={() => send("下单", () => write(addrs.exchange, exchangeAbi, "submitOrder", [side, tick, amountWei], GAS.submitOrder))}
            >
              提交订单
            </button>
          )}
          <p className="status">{status}</p>
          {latency !== undefined && <p className="latency">提交到确认：<b>{latency} ms</b></p>}
        </section>

        <section>
          <h2>我的订单</h2>
          <table>
            <thead><tr><th>#</th><th>区块</th><th>方向</th><th>价格</th><th>数量</th><th /></tr></thead>
            <tbody>
              {orders.map((o) => {
                const closed = head > o.batch;
                return (
                  <tr key={o.id}>
                    <td>{o.id}</td>
                    <td>{o.batch}</td>
                    <td className={o.side === 0 ? "buy" : "sell"}>{o.side === 0 ? "买" : "卖"}</td>
                    <td>{tickPrice(o.tick).toFixed(2)}</td>
                    <td>{fmt(o.amount)}</td>
                    <td>
                      {o.claimed ? (
                        "已领取"
                      ) : !closed ? (
                        "进行中"
                      ) : !o.settled ? (
                        <button onClick={() => send("清算", () => write(addrs.exchange, exchangeAbi, "settle", [BigInt(o.batch)], GAS.settle))}>清算</button>
                      ) : (
                        <button onClick={() => send("领取", () => write(addrs.exchange, exchangeAbi, "claim", [BigInt(o.id)], GAS.claim))}>领取</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
