/**
 * Stress demo: put hundreds of orders into the SAME Monad block, then clear the batch.
 *
 *   npx tsx scripts/stress.ts                      # defaults: 300 orders, 100 per tx
 *   ORDERS=1000 PER_TX=100 npx tsx scripts/stress.ts
 *   RPC_URL=http://127.0.0.1:8545 npx tsx scripts/stress.ts   # local anvil
 *
 * What it shows: orders-per-block grows with load, while `settle` stays a fixed ~155-175k gas
 * (a constant 64-tick scan), so clearing a 1,000-order batch costs the same as clearing 2.
 * `submitOrders` batches many orders into one transaction (~52k gas per order instead of ~230k),
 * and the transactions are sent back to back with locally managed nonces so they land together.
 * Reads DEPLOYER_PRIVATE_KEY from ../.env. Cost is about 0.5 MON per 100 orders at the 100 gwei base fee.
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
const ORDERS = Number(process.env.ORDERS ?? 300);
const PER_TX = Math.min(Number(process.env.PER_TX ?? 100), 250); // 250 x ~52k gas stays far below the 30M per-tx cap
const { base, quote, exchange } = deployments as Record<string, Address>;

const probe = createPublicClient({ transport: http(rpc) });
const chain = defineChain({ id: await probe.getChainId(), name: "target", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 500 });
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const wallet = createWalletClient({ account, chain, transport: http(rpc) });

const gasPrice = await pub.getGasPrice();
const txCount = Math.ceil(ORDERS / PER_TX);
const limitFor = (n: number) => BigInt(350_000 + 55_000 * n); // fixed limit with headroom (cold first order ~330k, then ~52k each): Monad charges gas_limit
const estimate = Array.from({ length: txCount }, (_, i) => limitFor(Math.min(PER_TX, ORDERS - i * PER_TX))).reduce((a, b) => a + b, 0n) * gasPrice * 11n / 10n;
const balance = await pub.getBalance({ address: account.address });
console.log(`${ORDERS} orders in ${txCount} tx (${PER_TX} each) on chain ${chain.id}; max cost ~${formatEther(estimate)} MON, balance ${formatEther(balance)} MON`);
if (balance < estimate) {
  console.error("Not enough MON for the worst case. Request more from the faucet, or lower ORDERS.");
  process.exit(1);
}

let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
const send = (address: Address, abi: any, functionName: string, args: any[], gas: bigint) =>
  wallet.writeContract({ address, abi, functionName, args, gas, nonce: nonce++, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: 1n } as any);

for (const token of [base, quote]) {
  const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, exchange] });
  if (allowance < 2n ** 128n) await pub.waitForTransactionReceipt({ hash: await send(token, erc20Abi, "approve", [exchange, 2n ** 256n - 1n], GAS.approve) });
}

const started = Date.now();
const jobs = Array.from({ length: txCount }, (_, i) => {
  const n = Math.min(PER_TX, ORDERS - i * PER_TX);
  const sides = Array.from({ length: n }, () => (Math.random() < 0.5 ? 0 : 1));
  const ticks = Array.from({ length: n }, () => 44 + Math.floor(Math.random() * 13)); // prices around 1.00
  const amounts = Array.from({ length: n }, () => parseEther(String(1 + Math.floor(Math.random() * 9))));
  return { n, args: [sides, ticks, amounts] };
});
// all transactions go out back to back so they land in the same block(s)
const hashes = await Promise.all(jobs.map((j) => send(exchange, exchangeAbi, "submitOrders", j.args, limitFor(j.n))));
const receipts = await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
const perBlock = new Map<bigint, number>();
let ok = 0;
receipts.forEach((r, i) => {
  if (r.status !== "success") return console.log(`tx ${i} reverted`);
  ok += jobs[i].n;
  perBlock.set(r.blockNumber, (perBlock.get(r.blockNumber) ?? 0) + jobs[i].n);
});
const secs = (Date.now() - started) / 1000;
console.log(`\n${ok}/${ORDERS} orders confirmed in ${secs.toFixed(1)}s`);
console.log("orders per block:");
for (const [b, n] of [...perBlock].sort((a, b) => (a[0] < b[0] ? -1 : 1))) console.log(`  block ${b}: ${n} orders`);

// clear every batch once its block is in the past; settle costs the same no matter how many orders it holds
let head = await pub.getBlockNumber();
while ([...perBlock.keys()].some((b) => b >= head)) {
  await new Promise((r) => setTimeout(r, 400));
  head = await pub.getBlockNumber();
}
console.log("\nclearing:");
for (const [b, n] of [...perBlock].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const t = Date.now();
  // Monad receipts report the gas LIMIT as gasUsed (it charges the limit), so measure the real need by simulation first
  const need = await pub.estimateContractGas({ address: exchange, abi: exchangeAbi, functionName: "settle", args: [b], account: account.address });
  const rc = await pub.waitForTransactionReceipt({ hash: await send(exchange, exchangeAbi, "settle", [b], GAS.settle) });
  const info = await pub.readContract({ address: exchange, abi: exchangeAbi, functionName: "getBatch", args: [b] });
  console.log(`  block ${b}: ${n} orders -> settle needs ${need} gas (limit charged ${rc.gasUsed}), clearing price ${(0.5 + info[1] * 0.01).toFixed(2)}, matched ${formatEther(info[2])} pMON, ${Date.now() - t} ms`);
}
console.log(`\nbalance left: ${formatEther(await pub.getBalance({ address: account.address }))} MON`);
