import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, custom, parseEther, type Address, type Hex } from "viem";
import { chain } from "./chain";
import { addrs, deployed, publicHttp, publicWs, readMany } from "./chainClients";
import { erc20Abi, exchangeAbi, GAS, manyGas } from "./abi";
import { AttackPanel } from "./AttackPanel";
import { MarketPanel } from "./MarketPanel";
import { BlockDetail } from "./BlockDetail";
import { OrderDetail } from "./OrderDetail";
import { ThemeToggle } from "./ThemeToggle";
import { useBatches } from "./useBatches";
import { derivedState, explorer, fmt, later, RANK, STATE_INFO, tickPrice, type CommitState, type MyOrder } from "./format";

interface Cell {
  number: number;
  real?: CommitState; // the state reported by the node (monadNewHeads); undefined = unknown, not "Proposed"
}

const eth = (window as unknown as { ethereum?: any }).ethereum;
interface Eip6963 {
  info: { uuid: string; name: string; rdns: string };
  provider: any;
}
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
  const [selected, setSelected] = useState<number>();
  const [tab, setTab] = useState<"trade" | "blocks" | "attack">("trade");
  const openBlock = (n: number) => {
    setSelected(n);
    setTab("blocks");
  };
  const [openOrder, setOpenOrder] = useState<number>();
  const [liveIds, setLiveIds] = useState<Record<number, number[]>>({}); // order ids seen live, per block (deduplicated)
  const { rows: batchRows, stats, error: batchErr, loaded: batchLoaded, reload: reloadBatches } = useBatches();
  const batchOf = useMemo(() => new Map(batchRows.map((r) => [r.batch, r])), [batchRows]);
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

  // --- timeline: restore the last blocks from the chain head, then follow new ones ---
  useEffect(() => {
    let stop = false;
    const addBlock = (n: number) =>
      setCells((prev) => {
        if (prev.some((c) => c.number === n)) return prev;
        return [...prev, { number: n }].sort((a, b) => a.number - b.number).slice(-MAX_CELLS);
      });
    // after a refresh the live feed starts empty: rebuild the recent block numbers from the head
    publicHttp
      .getBlockNumber()
      .then((h) => {
        if (stop) return;
        const head = Number(h);
        setCells((prev) => {
          const have = new Set(prev.map((c) => c.number));
          const fill = Array.from({ length: MAX_CELLS }, (_, i) => head - (MAX_CELLS - 1) + i).filter((n) => n >= 0 && !have.has(n)).map((n) => ({ number: n }));
          return [...prev, ...fill].sort((a, b) => a.number - b.number).slice(-MAX_CELLS);
        });
      })
      .catch(() => {});

    let gotBlock = false;
    const onBlock = (b: { number: bigint | null }) => {
      if (b.number == null) return;
      gotBlock = true;
      addBlock(Number(b.number));
    };
    const unwatchWs = publicWs.watchBlocks({ onBlock, onError: () => {} });
    // Some networks block WebSockets: if no block arrives in 5s, fall back to polling over HTTP.
    let unwatchHttp: (() => void) | undefined;
    const fallback = setTimeout(() => {
      if (!gotBlock) unwatchHttp = publicHttp.watchBlocks({ onBlock, onError: () => {}, poll: true, pollingInterval: 400 });
    }, 5000);

    // Monad extension: block updates carry the real commitState (and move forward over time).
    let unsub: (() => void) | undefined;
    try {
      const sub = (publicWs.transport as any).subscribe?.({
        params: ["monadNewHeads"],
        onData: (d: any) => {
          const h = d?.result ?? d;
          const n = Number(h?.number ?? h?.header?.number);
          const s = h?.commitState as CommitState | undefined;
          if (!n || !s || !(s in RANK)) return;
          setCells((prev) => prev.map((c) => (c.number === n ? { ...c, real: later(c.real, s) } : c)));
        },
        onError: () => {},
      });
      Promise.resolve(sub)
        .then((r: any) => (unsub = r?.unsubscribe))
        .catch(() => {});
    } catch {
      /* no real states available: cells stay "estimated" */
    }
    return () => {
      stop = true;
      unwatchWs();
      clearTimeout(fallback);
      unwatchHttp?.();
      unsub?.();
    };
  }, []);

  // --- live contract events: show new orders immediately (deduplicated by order id), refresh batches on clearing ---
  useEffect(() => {
    if (!deployed) return;
    const u1 = publicWs.watchContractEvent({
      address: addrs.exchange,
      abi: exchangeAbi,
      eventName: "OrderSubmitted",
      onLogs: (logs) => {
        setLiveIds((prev) => {
          const next = { ...prev };
          for (const l of logs) {
            const b = Number(l.args.batch);
            const id = Number(l.args.orderId);
            if (!(next[b] ?? []).includes(id)) next[b] = [...(next[b] ?? []), id];
          }
          return next;
        });
        reloadBatches();
      },
    });
    const u2 = publicWs.watchContractEvent({ address: addrs.exchange, abi: exchangeAbi, eventName: "BatchSettled", onLogs: () => reloadBatches() });
    return () => {
      u1();
      u2();
    };
  }, [reloadBatches]);

  const [readErr, setReadErr] = useState("");
  const [chainHead, setChainHead] = useState(0);
  // Public RPCs allow only ~15 requests/sec, so every poll is a handful of multicalls, never one call per order.
  const refresh = useCallback(async () => {
    if (!account || !deployed) return;
    try {
      // one multicall: balances, allowances and the account's newest orders (with settlement results)
      const [base, quote, allowBase, allowQuote, list] = await readMany([
        { address: addrs.base, abi: erc20Abi, functionName: "balanceOf", args: [account] },
        { address: addrs.quote, abi: erc20Abi, functionName: "balanceOf", args: [account] },
        { address: addrs.base, abi: erc20Abi, functionName: "allowance", args: [account, addrs.exchange] },
        { address: addrs.quote, abi: erc20Abi, functionName: "allowance", args: [account, addrs.exchange] },
        { address: addrs.exchange, abi: exchangeAbi, functionName: "ordersOf", args: [account, 40n] },
      ]);
      setBal({ base, quote, allowBase, allowQuote });
      setChainHead(Number(await publicHttp.getBlockNumber()));
      setOrders(
        (list as any[]).map((o) => ({
          id: Number(o.id),
          batch: Number(o.batch),
          tick: o.tick,
          side: o.side,
          claimed: o.claimed,
          amount: o.amount,
          settled: o.settled,
          filled: o.filled,
          baseOut: o.baseOut,
          quoteOut: o.quoteOut,
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
    // Only ask the wallet to switch networks when it is on another one: every request is a popup.
    if ((await wallet.getChainId()) !== chain.id) {
      try {
        await wallet.switchChain({ id: chain.id });
      } catch {
        await wallet.addChain({ chain });
      }
    }
    setAccount(a);
  }

  // Gas limits are fixed: Monad charges gas_limit, and a failed estimate can make wallets over-reserve.
  async function send(label: string, run: () => Promise<Hex>): Promise<{ ok: boolean; hash?: Hex; error?: string }> {
    setStatus(`${label}：等待签名…`);
    let hash: Hex | undefined;
    try {
      const t0 = performance.now();
      hash = await run();
      setLastTx({ label, hash });
      setStatus(`${label}：已提交，等待确认…`);
      const sent = performance.now();
      const receipt = await publicHttp.waitForTransactionReceipt({ hash, pollingInterval: 100 });
      if (receipt.status !== "success") throw new Error("交易已上链但被合约回退（失败），请在区块浏览器查看原因");
      setLatency(Math.round(performance.now() - sent));
      setStatus(`${label}：已确认（含签名 ${Math.round(performance.now() - t0)} ms）`);
      refresh();
      return { ok: true, hash };
    } catch (e: any) {
      const error = e?.shortMessage ?? e?.message ?? String(e);
      setStatus(`${label}失败：${error}`);
      return { ok: false, hash, error };
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
  const nowBlock = Math.max(head, chainHead);
  const toSettle = [...new Set(orders.filter((o) => !o.settled && !o.claimed && nowBlock > o.batch).map((o) => o.batch))].slice(0, 20);
  const toClaim = orders.filter((o) => o.settled && !o.claimed).slice(0, 40);
  const have = side === 0 ? bal.quote : bal.base;
  const need = side === 0 ? needQuote : amountWei;
  const lacking = have < need;
  const needApprove = side === 0 ? bal.allowQuote < needQuote : bal.allowBase < amountWei;

  return (
    <div className="app">
      <header>
        <div>
          <h1>Pulse</h1>
          <p>一个区块，一个价格 · one block, one price · <a href="#/">← 首页</a></p>
        </div>
        <div className="wallet">
          <ThemeToggle />
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

      <section className="timeline-wrap">
        <h2>脉冲时间轴 <small>每格一个区块 · 点击查看区块详情</small></h2>
        <p className="legend">
          颜色＝区块确认进度：黄 Proposed · 蓝 Voted · 绿 Finalized · 深绿 Verified。实线边框＝节点返回的真实状态；<b>虚线边框＝按区块距离推算</b>（页面打开前的区块无法获知真实状态）。✓＝该批次已清算。区块确认和批次清算是两件事。
        </p>
        {batchErr && <p className="warn-inline">{batchErr}。订单数、清算价暂时缺失，并不表示没有订单。</p>}
        <div className="timeline">
          {cells.map((c) => {
            const r = batchOf.get(c.number);
            const live = liveIds[c.number]?.length ?? 0;
            const orders = Math.max(r?.orders ?? 0, live);
            const state = c.real ?? derivedState(c.number, head);
            const tip = `区块 ${c.number}\n${STATE_INFO[state].label}${c.real ? "（真实）" : "（推算）"}${orders ? `\n${orders} 笔订单` : ""}${r?.settled ? (r.volume > 0 ? `\n已清算 @${r.price.toFixed(2)}` : "\n已清算，无成交") : orders ? "\n待清算" : ""}`;
            return (
              <div key={c.number} className={`cell ${state} ${c.real ? "real" : "derived"} ${selected === c.number ? "sel" : ""}`} title={tip} onClick={() => openBlock(c.number)}>
                <b>{String(c.number).slice(-4)}</b>
                <small>{orders ? `${orders} 单` : ""}</small>
                <small>{r?.settled ? (r.volume > 0 ? `@${r.price.toFixed(2)}` : "无成交") : ""}</small>
                {r?.settled && <span className="mark">✓</span>}
              </div>
            );
          })}
        </div>
      </section>

      <div className="tabs">
        <button className={tab === "trade" ? "on" : ""} onClick={() => setTab("trade")}>交易</button>
        <button className={tab === "blocks" ? "on" : ""} onClick={() => setTab("blocks")}>区块与行情</button>
        <button className={tab === "attack" ? "on" : ""} onClick={() => setTab("attack")}>攻击对比</button>
      </div>

      {tab === "blocks" && (
        <>
          {selected !== undefined && (
            <BlockDetail block={selected} head={Math.max(head, chainHead)} real={cells.find((c) => c.number === selected)?.real} row={batchOf.get(selected)} onClose={() => setSelected(undefined)} />
          )}
          <MarketPanel rows={batchRows} stats={stats} error={batchErr} loaded={batchLoaded} onSelect={openBlock} />
        </>
      )}

      {tab === "trade" && (
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
          {latency !== undefined && <p className="latency">链上确认耗时：<b>{latency} ms</b> <span className="muted">（从拿到交易哈希起算，不含钱包签名时间）</span></p>}
        </section>

        <section>
          <h2>我的订单</h2>
          {readErr && <p className="warn-inline">{readErr}</p>}
          {(toSettle.length > 0 || toClaim.length > 0) && (
            <div className="row bulk">
              {toSettle.length > 0 && (
                <button
                  onClick={() => send(`清算 ${toSettle.length} 批`, () => write(addrs.exchange, exchangeAbi, "settleMany", [toSettle.map((b) => BigInt(b))], manyGas.settle(toSettle.length)))}
                >
                  一键清算（{toSettle.length} 批）
                </button>
              )}
              {toClaim.length > 0 && (
                <button
                  onClick={() => send(`领取 ${toClaim.length} 笔`, () => write(addrs.exchange, exchangeAbi, "claimMany", [toClaim.map((o) => BigInt(o.id))], manyGas.claim(toClaim.length)))}
                >
                  一键领取（{toClaim.length} 笔）
                </button>
              )}
            </div>
          )}
          <table>
            <thead><tr><th>#</th><th>区块</th><th>方向</th><th>价格</th><th>数量</th><th>成交</th><th /></tr></thead>
            <tbody>
              {orders.map((o) => {
                const closed = Math.max(head, chainHead) > o.batch; // chainHead comes from HTTP, so it works even when WebSockets are blocked
                const noFill = o.settled && o.filled === 0n;
                return (
                  <Fragment key={o.id}>
                    <tr className="order-row" onClick={() => setOpenOrder(openOrder === o.id ? undefined : o.id)} title="点击展开订单详情">
                      <td>{o.id}</td>
                      <td><a onClick={(e) => { e.stopPropagation(); openBlock(o.batch); }}>{o.batch}</a></td>
                      <td className={o.side === 0 ? "buy" : "sell"}>{o.side === 0 ? "买" : "卖"}</td>
                      <td>{tickPrice(o.tick).toFixed(2)}</td>
                      <td>{fmt(o.amount)}</td>
                      <td>{o.settled ? (noFill ? <span title="本批次买卖价格未匹配或你的限价不满足，押金可全额领回">未成交</span> : fmt(o.filled)) : "–"}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {o.claimed ? (
                          noFill ? "已退款" : "已领取"
                        ) : !closed ? (
                          "进行中"
                        ) : !o.settled ? (
                          <button onClick={() => send("清算", () => write(addrs.exchange, exchangeAbi, "settle", [BigInt(o.batch)], GAS.settle))}>清算</button>
                        ) : (
                          <button onClick={() => send("领取", () => write(addrs.exchange, exchangeAbi, "claim", [BigInt(o.id)], GAS.claim))}>{noFill ? "领取退款" : "领取"}</button>
                        )}
                      </td>
                    </tr>
                    {openOrder === o.id && (
                      <tr key={`${o.id}-d`}>
                        <td colSpan={7}>
                          <OrderDetail o={o} row={batchOf.get(o.batch)} head={Math.max(head, chainHead)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
      )}

      {tab === "attack" && <AttackPanel send={send} write={write} enabled={!!account && deployed} />}
    </div>
  );
}
