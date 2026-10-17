/**
 * Keeper: clears every finished batch and claims for users, so a trader only has to place an order.
 *
 *   npx tsx scripts/keeper.ts                         # Monad testnet
 *   MAX_SPEND=0.8 AUTO_CLAIM=1 npx tsx scripts/keeper.ts
 *   RPC_URL=http://127.0.0.1:8545 npx tsx scripts/keeper.ts
 *
 * - `settle` is permissionless and only computes a deterministic price from the book: the keeper
 *   cannot influence the result, it just pays the gas (~155-175k per batch).
 * - `claim` pays the order's OWNER no matter who calls it, so the keeper can safely claim for users.
 *   It only handles orders created after it started (set START_FROM=<order id> to include older ones).
 * - MAX_SPEND (MON, default 0.8) caps what this process may burn on gas. When the cap is reached it stops.
 *   Monad charges the gas LIMIT, so every call costs limit x price.
 * - AUTO_CLAIM=0 turns claiming off and only settles.
 *
 * Uses KEEPER_PRIVATE_KEY from ../.env (falls back to DEPLOYER_PRIVATE_KEY). A separate key avoids nonce clashes with
 * the stress/bot scripts and keeps the spend limited to that wallet's balance. Stop with Ctrl+C or `pkill -f scripts/keeper.ts`.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { exchangeAbi, manyGas } from "../src/abi";
import deployments from "../src/deployments.json";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const rpc = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const MAX_SPEND = parseEther(process.env.MAX_SPEND ?? "0.8");
const AUTO_CLAIM = (process.env.AUTO_CLAIM ?? "1") !== "0";
const CLAIM_PER_TX = Math.min(Number(process.env.CLAIM_PER_TX ?? 40), 100);
const { exchange } = deployments as Record<string, Address>;

const probe = createPublicClient({ transport: http(rpc) });
const chain = defineChain({ id: await probe.getChainId(), name: "target", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } }, contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } } });
const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 500 });
const account = privateKeyToAccount((env.KEEPER_PRIVATE_KEY ?? env.DEPLOYER_PRIVATE_KEY) as Hex); // own key: no nonce clashes with stress/bot
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const gasPrice = await pub.getGasPrice();

const startBalance = await pub.getBalance({ address: account.address });
const spent = async () => startBalance - (await pub.getBalance({ address: account.address }));
const nonceOf = () => pub.getTransactionCount({ address: account.address, blockTag: "pending" });
const mon = (v: bigint) => Number(formatEther(v)).toFixed(4);

let nextId = process.env.START_FROM
  ? BigInt(process.env.START_FROM)
  : ((await pub.readContract({ address: exchange, abi: exchangeAbi, functionName: "ordersLength" })) as bigint);
const pending: { id: bigint; batch: bigint }[] = []; // orders seen but not yet claimed
let settledCount = 0;
let claimedCount = 0;

console.log(`keeper ${account.address} on chain ${chain.id}, exchange ${exchange}`);
console.log(`balance ${mon(startBalance)} MON, spend cap ${mon(MAX_SPEND)} MON, auto-claim ${AUTO_CLAIM ? "on" : "off"}, watching orders from #${nextId}`);

const send = async (functionName: "settleMany" | "claimMany", args: any[], gas: bigint) => {
  const hash = await wallet.writeContract({
    address: exchange, abi: exchangeAbi, functionName, args, gas, nonce: await nonceOf(),
    maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: 1n,
  } as any);
  return pub.waitForTransactionReceipt({ hash });
};

for (;;) {
  try {
    if ((await spent()) >= MAX_SPEND) {
      console.log(`spend cap reached (${mon(await spent())} MON): stopping. Settled ${settledCount} batches, claimed ${claimedCount} orders.`);
      process.exit(0);
    }

    const [head, recent, len] = await Promise.all([
      pub.getBlockNumber(),
      pub.readContract({ address: exchange, abi: exchangeAbi, functionName: "recentBatches", args: [64n] }),
      pub.readContract({ address: exchange, abi: exchangeAbi, functionName: "ordersLength" }),
    ]);

    // 1. settle every finished batch
    const todo = recent.filter((b) => !b.settled && b.batch < head).map((b) => b.batch).slice(0, 20);
    if (todo.length > 0) {
      const rc = await send("settleMany", [todo], manyGas.settle(todo.length));
      settledCount += todo.length;
      console.log(`settled ${todo.length} batch(es) [${todo.join(", ")}] status ${rc.status}, spent ${mon(await spent())} MON`);
      for (const b of todo) { const r = recent.find((x) => x.batch === b); if (r) r.settled = true; }
    }

    // 2. remember new orders, then claim the ones whose batch is settled
    if (AUTO_CLAIM) {
      if (len > nextId) {
        const ids: bigint[] = [];
        for (let i = nextId; i < len && ids.length < 300; i++) ids.push(i);
        // one multicall request: the public RPC allows only ~15 requests/sec, so never one call per order
        const rows = await pub.multicall({ contracts: ids.map((id) => ({ address: exchange, abi: exchangeAbi, functionName: "orders", args: [id] })), allowFailure: false });
        rows.forEach((o, i) => { if (!o[4]) pending.push({ id: ids[i], batch: o[1] }); });
        nextId += BigInt(ids.length);
      }
      const settledSet = new Set(recent.filter((b) => b.settled).map((b) => b.batch));
      const ready = pending.filter((p) => settledSet.has(p.batch)).slice(0, CLAIM_PER_TX);
      if (ready.length > 0) {
        const rc = await send("claimMany", [ready.map((p) => p.id)], manyGas.claim(ready.length));
        if (rc.status === "success") {
          claimedCount += ready.length;
          const done = new Set(ready.map((p) => p.id));
          for (let i = pending.length - 1; i >= 0; i--) if (done.has(pending[i].id)) pending.splice(i, 1);
        }
        console.log(`claimed ${ready.length} order(s) for their owners, status ${rc.status}, spent ${mon(await spent())} MON, ${pending.length} waiting`);
      }
    }
  } catch (e: any) {
    console.error("keeper error:", e.shortMessage ?? e.message);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
