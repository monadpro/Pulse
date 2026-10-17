/**
 * Maker: a short, capped burst of liquidity so that an ordinary one-sided order can fill.
 *
 * A Pulse order only lives in the block it lands in, so a lone buy has nobody to trade with. This script posts
 * one order per block for a few seconds from OUR OWN account; anyone who submits an order on the other side
 * during that window is matched with it at the uniform price. It is a market maker: say so when you demo it.
 *
 *   npx tsx scripts/maker.ts                    # sell 20 pMON at 1.00 every block for 40 s (fills BUY orders >= 1.00)
 *   SIDE=buy npx tsx scripts/maker.ts           # buy 20 pMON at 1.00 (fills SELL orders <= 1.00)
 *   SECONDS=60 TICK=50 AMOUNT=20 MAX_SPEND=6 npx tsx scripts/maker.ts
 *
 * Measured cost: each block of liquidity costs ~0.036 MON for the maker (Monad charges the gas limit) PLUS ~0.05 MON for
 * the keeper to clear and claim it, so a 40 s burst (~130 blocks) is roughly 10 MON in total. MAX_SPEND caps only the maker.
 * Uses MAKER_PRIVATE_KEY from ../.env. Stop early with Ctrl+C.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, exchangeAbi, GAS } from "../src/abi";
import deployments from "../src/deployments.json";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const rpc = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const SIDE = (process.env.SIDE ?? "sell") === "buy" ? 0 : 1; // 0 = buy, 1 = sell
const TICK = Number(process.env.TICK ?? 50); // 50 = price 1.00
const AMOUNT = parseEther(process.env.AMOUNT ?? "20");
const SECONDS = Number(process.env.SECONDS ?? 40);
const INTERVAL = Number(process.env.INTERVAL_MS ?? 300); // one order per block (~0.3 s)
const MAX_SPEND = parseEther(process.env.MAX_SPEND ?? "6");
const { base, quote, exchange } = deployments as Record<string, Address>;

const probe = createPublicClient({ transport: http(rpc) });
const chain = defineChain({ id: await probe.getChainId(), name: "target", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc) });
const account = privateKeyToAccount(env.MAKER_PRIVATE_KEY as Hex);
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const gasPrice = await pub.getGasPrice();

const token = SIDE === 1 ? base : quote; // a sell escrows pMON, a buy escrows pUSD
const need = SIDE === 1 ? AMOUNT : (AMOUNT * BigInt(50 + TICK - 50)) / 1n; // generous: price <= 1.13
const start = await pub.getBalance({ address: account.address });
const bal = (await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
const allowance = (await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, exchange] })) as bigint;
const orders = Math.ceil((SECONDS * 1000) / INTERVAL);
console.log(`maker ${account.address}: ${SIDE === 1 ? "SELL" : "BUY"} ${formatEther(AMOUNT)} pMON @ ${(0.5 + TICK * 0.01).toFixed(2)} every ${INTERVAL} ms for ${SECONDS}s (~${orders} orders)`);
console.log(`MON ${Number(formatEther(start)).toFixed(3)}, escrow needed ~${formatEther(AMOUNT * BigInt(orders))} of the token, have ${formatEther(bal)}, spend cap ${formatEther(MAX_SPEND)} MON`);
if (bal < AMOUNT * BigInt(orders) && SIDE === 1) console.log("note: the escrow comes back when the keeper claims the unsold orders, so a short balance can stop the burst early");
if (allowance < 2n ** 128n) {
  const h = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [exchange, 2n ** 256n - 1n], gas: GAS.approve, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: 1n } as any);
  await pub.waitForTransactionReceipt({ hash: h });
  console.log("approved the exchange");
}

let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
let sent = 0;
let failed = 0;
const t0 = Date.now();
console.log("\n>>> LIQUIDITY IS ON: submit your order now <<<");
const timer = setInterval(async () => {
  if (Date.now() - t0 > SECONDS * 1000) return;
  const n = nonce++;
  try {
    await wallet.writeContract({
      address: exchange, abi: exchangeAbi, functionName: "submitOrder", args: [SIDE, TICK, AMOUNT],
      gas: GAS.submitOrder, nonce: n, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: 1n,
    } as any);
    sent++;
  } catch {
    failed++;
  }
}, INTERVAL);

const capCheck = setInterval(async () => {
  const spent = start - (await pub.getBalance({ address: account.address }).catch(() => start));
  if (spent >= MAX_SPEND) {
    console.log(`spend cap reached (${formatEther(spent)} MON): stopping`);
    clearInterval(timer);
  }
}, 4000);

await new Promise((r) => setTimeout(r, SECONDS * 1000 + 1500));
clearInterval(timer);
clearInterval(capCheck);
await new Promise((r) => setTimeout(r, 3000));
const end = await pub.getBalance({ address: account.address });
console.log(`\ndone: ${sent} orders sent (${failed} failed to send), ~${Number(formatEther(start - end)).toFixed(2)} MON spent. The keeper will clear and refund the unsold ones.`);
process.exit(0);
