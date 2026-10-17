import { useState } from "react";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { addrs, publicHttp } from "./chainClients";
import { exchangeAbi, labAbi, LAB_GAS } from "./abi";

const VICTIM = parseEther("1000");
const ATTACKER = parseEther("3000");
const n = (v: bigint, d = 2) => Number(formatEther(v < 0n ? -v : v)).toLocaleString(undefined, { maximumFractionDigits: d });

interface Amm { fair: bigint; got: bigint; profit: bigint }
interface Pulse { price: bigint; victimBase: bigint; paid: bigint; profit: bigint }

/** Replays one sandwich (attacker buys, victim buys, attacker sells) against an AMM and against Pulse. */
export function AttackPanel({ send, write, enabled }: {
  send: (label: string, run: () => Promise<Hex>) => Promise<boolean>;
  write: (address: Address, abi: any, fn: string, args: any[], gas: bigint) => Promise<Hex>;
  enabled: boolean;
}) {
  const [amm, setAmm] = useState<Amm>();
  const [pulse, setPulse] = useState<Pulse>();
  const [busy, setBusy] = useState(false);

  async function runAmm() {
    setBusy(true);
    const ok = await send("AMM 攻击", () => write(addrs.lab, labAbi, "runAmm", [VICTIM, ATTACKER], LAB_GAS.runAmm));
    if (ok) {
      const r = await publicHttp.readContract({ address: addrs.lab, abi: labAbi, functionName: "lastAmm" });
      setAmm({ fair: r[0], got: r[1], profit: r[2] });
    }
    setBusy(false);
  }

  async function runPulse() {
    setBusy(true);
    const ok1 = await send("Pulse 攻击：同一区块提交 4 笔订单", () =>
      write(addrs.lab, labAbi, "runPulse", [VICTIM, ATTACKER], LAB_GAS.runPulse),
    );
    if (ok1) {
      // A keeper may clear the batch (and claim) on its own within a second or two. Give it a moment, and only
      // clear it ourselves if it has not happened; the report below works either way.
      const round = await publicHttp.readContract({ address: addrs.lab, abi: labAbi, functionName: "round" });
      const isSettled = async () =>
        (await publicHttp.readContract({ address: addrs.exchange, abi: exchangeAbi, functionName: "getBatch", args: [round[0]] }))[0];
      let settled = false;
      for (let i = 0; i < 10 && !settled; i++) {
        await new Promise((r) => setTimeout(r, 500));
        settled = await isSettled().catch(() => false);
      }
      if (!settled) {
        await send("Pulse 清算并领取", () => write(addrs.lab, labAbi, "finishPulse", [], LAB_GAS.finishPulse));
      }
      try {
        const r = await publicHttp.readContract({ address: addrs.lab, abi: labAbi, functionName: "pulseReport" });
        setPulse({ price: r[0], victimBase: r[1], paid: r[2], profit: r[3] });
      } catch {
        /* the report needs a cleared batch; try again with the button */
      }
    }
    setBusy(false);
  }

  const loss = amm && amm.fair > 0n ? Number(((amm.fair - amm.got) * 10000n) / amm.fair) / 100 : 0;

  return (
    <section>
      <h2>攻击对比 <small>模拟一个能随意调整区块内交易顺序的恶意出块者：先买入，受害者买入，再卖出</small></h2>
      <div className="vs">
        <div className="card bad">
          <h3>普通 AMM</h3>
          <button disabled={!enabled || busy} onClick={runAmm}>运行攻击</button>
          {amm ? (
            <ul>
              <li>受害者本应买到 <b>{n(amm.fair)}</b> pMON</li>
              <li>实际只买到 <b>{n(amm.got)}</b> pMON（少了 <b>{loss}%</b>）</li>
              <li>攻击者净赚 <b className="sell">{n(amm.profit)}</b> pUSD</li>
            </ul>
          ) : (
            <p className="muted">受害者出 {n(VICTIM, 0)} pUSD，攻击者出 {n(ATTACKER, 0)} pUSD</p>
          )}
        </div>
        <div className="card good">
          <h3>Pulse</h3>
          <button disabled={!enabled || busy} onClick={runPulse}>运行攻击</button>
          {pulse ? (
            <ul>
              <li>统一成交价 <b>{n(pulse.price)}</b> pUSD</li>
              <li>受害者买到 <b>{n(pulse.victimBase)}</b> pMON，花了 <b>{n(pulse.paid)}</b> pUSD</li>
              <li>攻击者净利润 <b className="buy">{pulse.profit > 10n ** 12n ? "+" : ""}{pulse.profit < -(10n ** 12n) ? "-" : ""}{n(pulse.profit, 6)}</b> pUSD（没有收益）</li>
            </ul>
          ) : (
            <p className="muted">同样的攻击，同一个区块里 4 笔订单按同一价格成交</p>
          )}
        </div>
      </div>
    </section>
  );
}
