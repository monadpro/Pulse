/**
 * Stress bot: fires many orders into the same Monad blocks to show per-block batching.
 *
 *   npx tsx scripts/bot.ts            # defaults: 3 rounds x 8 orders
 *   ROUNDS=5 PER_ROUND=12 npx tsx scripts/bot.ts
 *   RPC_URL=http://127.0.0.1:8545 npx tsx scripts/bot.ts   # local anvil
 *
 * Reads DEPLOYER_PRIVATE_KEY from ../.env. Gas limits are fixed and nonces are managed locally,
 * because Monad charges gas_limit and has no global mempool to re-order pending nonces.
 * Each order costs roughly 0.024 MON at the 100 gwei base fee, so size the run to your balance.
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
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const PER_ROUND = Number(process.env.PER_ROUND ?? 8);
const { base, quote, exchange } = deployments as Record<string, Address>;

const probe = createPublicClient({ transport: http(rpc) });
const chain = defineChain({ id: await probe.getChainId(), name: "target", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 100 });
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const wallet = createWalletClient({ account, chain, transport: http(rpc) });

const gasPrice = await pub.getGasPrice();
const maxFee = gasPrice * 2n;
let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
const send = (address: Address, abi: any, functionName: string, args: any[], gas: bigint) =>
  wallet.writeContract({ address, abi, functionName, args, gas, nonce: nonce++, maxFeePerGas: maxFee, maxPriorityFeePerGas: 1n } as any);

console.log(`bot ${account.address} on chain ${chain.id}, balance ${formatEther(await pub.getBalance({ address: account.address }))} MON`);
for (const token of [base, quote]) {
  const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, exchange] });
  if (allowance < 2n ** 128n) {
    const h = await send(token, erc20Abi, "approve", [exchange, 2n ** 256n - 1n], GAS.approve);
    await pub.waitForTransactionReceipt({ hash: h });
  }
}

const batches = new Set<bigint>();
const perBlock = new Map<bigint, number>();
const started = Date.now();
let sent = 0;
for (let r = 0; r < ROUNDS; r++) {
  // all orders of a round are sent back to back so they land in the same few blocks
  const hashes = await Promise.all(
    Array.from({ length: PER_ROUND }, () => {
      const side = Math.random() < 0.5 ? 0 : 1;
      const tick = 44 + Math.floor(Math.random() * 13); // prices around 1.00
      const amount = parseEther(String(1 + Math.floor(Math.random() * 9)));
      return send(exchange, exchangeAbi, "submitOrder", [side, tick, amount], GAS.submitOrder);
    }),
  );
  const receipts = await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
  for (const rc of receipts) {
    if (rc.status !== "success") continue;
    sent++;
    batches.add(rc.blockNumber);
    perBlock.set(rc.blockNumber, (perBlock.get(rc.blockNumber) ?? 0) + 1);
  }
  console.log(`round ${r + 1}/${ROUNDS}: ${receipts.filter((x) => x.status === "success").length}/${PER_ROUND} orders confirmed`);
}

const head = await pub.getBlockNumber();
const toSettle = [...batches].filter((b) => b < head).sort();
for (const b of toSettle) {
  const h = await send(exchange, exchangeAbi, "settle", [b], GAS.settle);
  await pub.waitForTransactionReceipt({ hash: h });
}
const secs = (Date.now() - started) / 1000;
const max = Math.max(...perBlock.values());
console.log(`\n${sent} orders in ${secs.toFixed(1)}s across ${batches.size} blocks, up to ${max} orders in one block; ${toSettle.length} batches settled`);
console.log(`balance left: ${formatEther(await pub.getBalance({ address: account.address }))} MON`);
