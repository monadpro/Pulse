import { useState } from "react";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { addrs, publicHttp } from "./chainClients";
import { exchangeAbi, labAbi, LAB_GAS } from "./abi";
import { explorer } from "./format";

const VICTIM = parseEther("1000");
const ATTACKER = parseEther("3000");
const EPS = 10n ** 12n; // below 0.000001 pUSD is rounding noise
const n = (v: bigint, d = 2) => Number(formatEther(v < 0n ? -v : v)).toLocaleString(undefined, { maximumFractionDigits: d });

interface Amm { fair: bigint; got: bigint; profit: bigint }
interface Pulse { price: bigint; victimBase: bigint; paid: bigint; profit: bigint }
interface SendResult { ok: boolean; hash?: Hex; error?: string }
interface Step { label: string; state: "run" | "ok" | "fail"; hash?: Hex; note?: string }

function Progress({ steps, batch }: { steps: Step[]; batch?: number }) {
  if (steps.length === 0) return null;
  return (
    <ol className="progress">
      {batch !== undefined && <li className="muted">批次（区块）：{explorer ? <a href={`${explorer}/block/${batch}`} target="_blank" rel="noreferrer">{batch}</a> : batch}</li>}
      {steps.map((s, i) => (
        <li key={i} className={s.state}>
          {s.state === "ok" ? "✓" : s.state === "fail" ? "✗" : "⏳"} {s.label}
          {s.hash && explorer && <> · <a href={`${explorer}/tx/${s.hash}`} target="_blank" rel="noreferrer">{s.hash.slice(0, 8)}…{s.hash.slice(-4)}</a></>}
          {s.note && <span className="muted"> · {s.note}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Replays one sandwich (attacker buys, victim buys, attacker sells) against an AMM and against Pulse. */
export function AttackPanel({ send, write, enabled }: {
  send: (label: string, run: () => Promise<Hex>) => Promise<SendResult>;
  write: (address: Address, abi: any, fn: string, args: any[], gas: bigint) => Promise<Hex>;
  enabled: boolean;
}) {
  const [amm, setAmm] = useState<Amm>();
  const [pulse, setPulse] = useState<Pulse>();
  const [ammSteps, setAmmSteps] = useState<Step[]>([]);
  const [pulseSteps, setPulseSteps] = useState<Step[]>([]);
  const [batch, setBatch] = useState<number>();
  const [busy, setBusy] = useState(false);

  async function runAmm() {
    setBusy(true);
    setAmm(undefined);
    setAmmSteps([{ label: "提交攻击交易（等待钱包确认）", state: "run" }]);
    const r = await send("AMM 攻击", () => write(addrs.lab, labAbi, "runAmm", [VICTIM, ATTACKER], LAB_GAS.runAmm));
    if (!r.ok) {
      setAmmSteps([{ label: "攻击交易失败", state: "fail", hash: r.hash, note: r.error }]);
    } else {
      const res = await publicHttp.readContract({ address: addrs.lab, abi: labAbi, functionName: "lastAmm" });
      setAmmSteps([{ label: "攻击交易已确认", state: "ok", hash: r.hash }]);
      setAmm({ fair: res[0], got: res[1], profit: res[2] });
    }
    setBusy(false);
  }

  async function runPulse() {
    setBusy(true);
    setPulse(undefined);
    setBatch(undefined);
    setPulseSteps([{ label: "同一区块提交 4 笔订单（等待钱包确认）", state: "run" }]);
    const r1 = await send("Pulse 攻击：同一区块提交 4 笔订单", () => write(addrs.lab, labAbi, "runPulse", [VICTIM, ATTACKER], LAB_GAS.runPulse));
    if (!r1.ok) {
      setPulseSteps([{ label: "提交订单失败", state: "fail", hash: r1.hash, note: r1.error }]);
      setBusy(false);
      return;
    }
    const steps: Step[] = [{ label: "4 笔订单已在同一区块提交", state: "ok", hash: r1.hash }, { label: "等待清算", state: "run" }];
    setPulseSteps([...steps]);
    // A keeper may clear the batch (and claim) on its own within a second or two. Give it a moment, and only
    // clear it ourselves if it has not happened; the report below works either way.
    const round = await publicHttp.readContract({ address: addrs.lab, abi: labAbi, functionName: "round" });
    setBatch(Number(round[0]));
    const isSettled = async () =>
      (await publicHttp.readContract({ address: addrs.exchange, abi: exchangeAbi, functionName: "getBatch", args: [round[0]] }))[0];
    let settled = false;
    for (let i = 0; i < 10 && !settled; i++) {
      await new Promise((r) => setTimeout(r, 500));
      settled = await isSettled().catch(() => false);
    }
    if (settled) {
      steps[1] = { label: "批次已清算", state: "ok", note: "由自动清算脚本完成" };
    } else {
      const r2 = await send("Pulse 清算并领取", () => write(addrs.lab, labAbi, "finishPulse", [], LAB_GAS.finishPulse));
      steps[1] = r2.ok ? { label: "批次已清算", state: "ok", hash: r2.hash, note: "由你确认的清算交易完成" } : { label: "清算交易失败", state: "fail", hash: r2.hash, note: r2.error };
    }
    setPulseSteps([...steps]);
    try {
      const rep = await publicHttp.readContract({ address: addrs.lab, abi: labAbi, functionName: "pulseReport" });
      setPulse({ price: rep[0], victimBase: rep[1], paid: rep[2], profit: rep[3] });
      steps.push({ label: "已读取链上结果", state: "ok" });
    } catch (e: any) {
      steps.push({ label: "读取结果失败（批次可能尚未清算，可再点一次）", state: "fail", note: e?.shortMessage ?? e?.message });
    }
    setPulseSteps([...steps]);
    setBusy(false);
  }

  const loss = amm && amm.fair > 0n ? Number(((amm.fair - amm.got) * 10000n) / amm.fair) / 100 : 0;

  return (
    <section>
      <h2>攻击对比 <small>链上受控模拟：同一种三明治攻击（先买入，受害者买入，再卖出）分别打在普通 AMM 和 Pulse 上</small></h2>
      <p className="muted">
        说明：这不是真实攻击记录。AttackLab 合约同时扮演攻击者、受害者和流动性提供者，订单属于该合约，不是你的个人订单，也不会动用你的币，你只付手续费。结果由合约计算并从链上读取。
      </p>
      <div className="vs">
        <div className="card bad">
          <h3>普通 AMM</h3>
          <button disabled={!enabled || busy} onClick={runAmm}>运行攻击</button>
          <Progress steps={ammSteps} />
          {amm ? (
            <ul>
              <li>受害者本应买到 <b>{n(amm.fair)}</b> pMON</li>
              <li>实际只买到 <b>{n(amm.got)}</b> pMON（{amm.got < amm.fair ? <>少了 <b>{loss}%</b></> : "没有少买"}）</li>
              <li>
                攻击者净{amm.profit >= 0n ? "赚" : "亏"} <b className={amm.profit > 0n ? "sell" : ""}>{n(amm.profit)}</b> pUSD
              </li>
              <li className="muted">AMM 池子的状态会被每次攻击改变，重复运行时数字会略有不同。</li>
            </ul>
          ) : ammSteps.length === 0 ? (
            <p className="muted">等待运行。受害者出 {n(VICTIM, 0)} pUSD，攻击者出 {n(ATTACKER, 0)} pUSD</p>
          ) : null}
        </div>
        <div className="card good">
          <h3>Pulse</h3>
          <button disabled={!enabled || busy} onClick={runPulse}>运行攻击</button>
          <Progress steps={pulseSteps} batch={batch} />
          {pulse ? (
            <ul>
              <li>统一成交价 <b>{n(pulse.price)}</b> pUSD</li>
              <li>受害者买到 <b>{n(pulse.victimBase)}</b> pMON，花了 <b>{n(pulse.paid)}</b> pUSD</li>
              <li>
                攻击者净利润{" "}
                {pulse.profit > EPS ? (
                  <><b className="sell">+{n(pulse.profit, 6)}</b> pUSD（本次实验中攻击者有净利润，请核查）</>
                ) : pulse.profit < -EPS ? (
                  <><b>-{n(pulse.profit, 6)}</b> pUSD（攻击者亏损）</>
                ) : (
                  <><b className="buy">约 0</b>（绝对值不超过 0.000001 pUSD，含舍入误差）</>
                )}
              </li>
            </ul>
          ) : pulseSteps.length === 0 ? (
            <p className="muted">等待运行。同一个区块里 4 笔订单按同一价格成交</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
