import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, custom, formatEther, parseEther, type Address, type Hex } from "viem";
import { chain } from "./chain";
import { addrs, deployed, publicHttp, publicWs, readMany } from "./chainClients";
import { erc20Abi, exchangeAbi, GAS } from "./abi";
import { AttackPanel } from "./AttackPanel";

type CommitState = "Proposed" | "Voted" | "Finalized" | "Verified";
const RANK: Record<CommitState, number> = { Proposed: 0, Voted: 1, Finalized: 2, Verified: 3 };
const later = (a: CommitState, b: CommitState) => (RANK[b] > RANK[a] ? b : a);
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
interface Eip6963 {
  info: { uuid: string; name: string; rdns: string };
  provider: any;
}
const explorer = chain.blockExplorers?.default.url;
const fmt = (v: bigint) => Number(formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 2 });
const tickPrice = (t: number) => 0.5 + t * 0.01;
const MAX_CELLS = 36;
// A bounded allowance (not unlimited): safer for users and avoids wallet 'unlimited approval' warnings.
const APPROVE_LIMIT = parseEther("100000");

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

  // EIP-6963: discover every installed wallet instead of trusting whichever one grabbed window.ethereum.
  const [providers, setProviders] = useState<Eip6963[]>([]);
  const [picked, setPicked] = useState<string>();
  useEffect(() => {
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<Eip6963>).detail;
      setProviders((prev) => (prev.some((p) => p.info.uuid === d.info.uuid) ? prev : [...prev, d]));
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);
  const active =
    providers.find((p) => p.info.uuid === picked) ??
    providers.find((p) => p.info.rdns === "io.metamask") ??
    providers[0];
  const injected = active?.provider ?? eth;
  const wallet = useMemo(
    () => (injected ? createWalletClient({ chain, transport: custom(injected) }) : undefined),
    [injected],
  );
  const [lastTx, setLastTx] = useState<{ label: string; hash: Hex }>();

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
            state: later(c.state, n - c.number >= 2 ? "Finalized" : n - c.number === 1 ? "Voted" : "Proposed"),
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
          if (!(s in RANK)) return;
          setCells((prev) => prev.map((c) => (c.number === n ? { ...c, state: later(c.state, s) } : c)));
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

  const [readErr, setReadErr] = useState("");
  // Public RPCs allow only ~15 requests/sec, so every poll is a handful of multicalls, never one call per order.
  const refresh = useCallback(async () => {
    if (!account || !deployed) return;
    try {
      const [base, quote, allowBase, allowQuote, lenRaw] = await readMany([
        { address: addrs.base, abi: erc20Abi, functionName: "balanceOf", args: [account] },
        { address: addrs.quote, abi: erc20Abi, functionName: "balanceOf", args: [account] },
        { address: addrs.base, abi: erc20Abi, functionName: "allowance", args: [account, addrs.exchange] },
        { address: addrs.quote, abi: erc20Abi, functionName: "allowance", args: [account, addrs.exchange] },
        { address: addrs.exchange, abi: exchangeAbi, functionName: "ordersLength" },
      ]);
      setBal({ base, quote, allowBase, allowQuote });

      const len = Number(lenRaw);
      const ids = Array.from({ length: Math.min(len, 100) }, (_, i) => len - 1 - i);
      const raw = await readMany(
        ids.map((id) => ({ address: addrs.exchange, abi: exchangeAbi, functionName: "orders", args: [BigInt(id)] })),
      );
      const mine = ids
        .map((id, i) => ({ id, o: raw[i] }))
        .filter((x) => x.o[0].toLowerCase() === account.toLowerCase());
      const batches = [...new Set(mine.map((x) => x.o[1] as bigint))];
      const info = await readMany(
        batches.map((b) => ({ address: addrs.exchange, abi: exchangeAbi, functionName: "getBatch", args: [b] })),
      );
      const settledMap = new Map<bigint, boolean>(batches.map((b, i) => [b, info[i][0] as boolean]));
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
      setReadErr("");
    } catch (e: any) {
      setReadErr(`读取链上数据失败，稍后自动重试：${e?.shortMessage ?? e?.message ?? e}`);
    }
  }, [account]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Follow account changes made inside the wallet (MetaMask account menu) without a reload.
  useEffect(() => {
    if (!injected?.on) return;
    const onAccounts = (accs: string[]) => {
      setAccount(accs[0] as Address | undefined);
      if (!accs[0]) setOrders([]);
    };
    injected.on("accountsChanged", onAccounts);
    return () => injected.removeListener?.("accountsChanged", onAccounts);
  }, [injected]);

  /** Opens the wallet's own account picker so the user can tick another account (or import one there first). */
  async function switchAccount() {
    if (!injected || !wallet) return;
    try {
      await injected.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      const [a] = await wallet.requestAddresses();
      setAccount(a);
      setStatus("");
    } catch (e: any) {
      setStatus(`切换账户失败：${e?.shortMessage ?? e?.message ?? e}`);
    }
  }

  function disconnect() {
    setAccount(undefined);
    setOrders([]);
    setBal({ base: 0n, quote: 0n, allowBase: 0n, allowQuote: 0n });
    setLastTx(undefined);
    setStatus("");
  }

  async function connect() {
    if (!injected || !wallet) return setStatus("未检测到钱包，请安装 MetaMask");
    setAccount(undefined);
    const [a] = await wallet.requestAddresses();
    try {
      await wallet.switchChain({ id: chain.id });
    } catch {
      await wallet.addChain({ chain });
    }
    setAccount(a);
  }

  // Gas limits are fixed: Monad charges gas_limit, and a failed estimate can make wallets over-reserve.
  async function send(label: string, run: () => Promise<Hex>): Promise<boolean> {
    setStatus(`${label}：等待签名…`);
    try {
      const t0 = performance.now();
      const hash = await run();
      setLastTx({ label, hash });
      setStatus(`${label}：已提交，等待确认…`);
      const sent = performance.now();
      await publicHttp.waitForTransactionReceipt({ hash, pollingInterval: 100 });
      setLatency(Math.round(performance.now() - sent));
      setStatus(`${label}：已确认（含签名 ${Math.round(performance.now() - t0)} ms）`);
      refresh();
      return true;
    } catch (e: any) {
      setStatus(`${label}失败：${e?.shortMessage ?? e?.message ?? e}`);
      return false;
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
  const have = side === 0 ? bal.quote : bal.base;
  const need = side === 0 ? needQuote : amountWei;
  const lacking = have < need;
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
              {providers.length > 1 && (
                <select value={active?.info.uuid} onChange={(e) => setPicked(e.target.value)}>
                  {providers.map((p) => (
                    <option key={p.info.uuid} value={p.info.uuid}>{p.info.name}</option>
                  ))}
                </select>
              )}
              <span title={account}>{account.slice(0, 6)}…{account.slice(-4)}</span>
              <span>pMON {fmt(bal.base)}</span>
              <span>pUSD {fmt(bal.quote)}</span>
              <button onClick={switchAccount}>切换账户</button>
              <button onClick={disconnect}>断开</button>
            </>
          ) : (
            <>
              {providers.length > 1 && (
                <select value={active?.info.uuid} onChange={(e) => setPicked(e.target.value)}>
                  {providers.map((p) => (
                    <option key={p.info.uuid} value={p.info.uuid}>{p.info.name}</option>
                  ))}
                </select>
              )}
              <button onClick={connect}>连接钱包{active ? `（${active.info.name}）` : ""}</button>
            </>
          )}
        </div>
      </header>

      {!deployed && <div className="warn">合约尚未部署：运行 forge script script/Deploy.s.sol，地址会写入 web/src/deployments.json</div>}

      <section>
        <h2>脉冲时间轴 <small>每格一个区块 · 黄 Proposed · 蓝 Voted · 绿 Finalized · 深绿 Verified</small></h2>
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
          {account && deployed && amountWei > 0n && lacking ? (
            <p className="warn-inline">
              余额不足：需要 {fmt(need)} {side === 0 ? "pUSD" : "pMON"}，你有 {fmt(have)}。请先点上面的“领 {side === 0 ? "pUSD" : "pMON"}”。
            </p>
          ) : null}
          {needApprove ? (
            <button
              className="primary"
              disabled={!account || !deployed || lacking}
              onClick={() =>
                send("授权", () =>
                  write(side === 0 ? addrs.quote : addrs.base, erc20Abi, "approve", [addrs.exchange, APPROVE_LIMIT], GAS.approve),
                )
              }
            >
              先授权 {side === 0 ? "pUSD" : "pMON"}
            </button>
          ) : (
            <button
              className="primary"
              disabled={!account || !deployed || amountWei === 0n || lacking}
              onClick={() => send("下单", () => write(addrs.exchange, exchangeAbi, "submitOrder", [side, tick, amountWei], GAS.submitOrder))}
            >
              提交订单
            </button>
          )}
          <p className="status">{status}</p>
          {lastTx && (
            <p className="status">
              最近交易：{lastTx.label}{" "}
              {explorer ? (
                <a href={`${explorer}/tx/${lastTx.hash}`} target="_blank" rel="noreferrer">{lastTx.hash.slice(0, 10)}…{lastTx.hash.slice(-6)}</a>
              ) : (
                lastTx.hash
              )}
            </p>
          )}
          {account && explorer && (
            <p className="status"><a href={`${explorer}/address/${account}`} target="_blank" rel="noreferrer">在区块浏览器查看我的全部交易</a></p>
          )}
          {latency !== undefined && <p className="latency">提交到确认：<b>{latency} ms</b></p>}
        </section>

        <section>
          <h2>我的订单</h2>
          {readErr && <p className="warn-inline">{readErr}</p>}
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

      <AttackPanel send={send} write={write} enabled={!!account && deployed} />
    </div>
  );
}
