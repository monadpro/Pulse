/**
 * Auto-settle keeper: watches the chain and clears every finished batch, so nobody has to press "清算".
 * Anyone can run it: `settle` is permissionless and costs a fixed ~155k gas per batch.
 *
 *   npx tsx scripts/keeper.ts                       # Monad testnet
 *   RPC_URL=http://127.0.0.1:8545 npx tsx scripts/keeper.ts
 *
 * Reads DEPLOYER_PRIVATE_KEY from ../.env (any funded testnet key works).
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, type Address, type Hex } from "viem";
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
const { exchange } = deployments as Record<string, Address>;

const probe = createPublicClient({ transport: http(rpc) });
const chain = defineChain({ id: await probe.getChainId(), name: "target", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 500 });
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const gasPrice = await pub.getGasPrice();

console.log(`keeper ${account.address} watching ${exchange} on chain ${chain.id}`);
let settled = 0;
for (;;) {
  try {
    const [head, recent] = await Promise.all([
      pub.getBlockNumber(),
      pub.readContract({ address: exchange, abi: exchangeAbi, functionName: "recentBatches", args: [32n] }),
    ]);
    const todo = recent.filter((b) => !b.settled && b.batch < head).map((b) => b.batch);
    if (todo.length > 0) {
      const batch = todo.slice(0, 20);
      const hash = await wallet.writeContract({
        address: exchange, abi: exchangeAbi, functionName: "settleMany", args: [batch],
        gas: manyGas.settle(batch.length), maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: 1n,
      } as any);
      const rc = await pub.waitForTransactionReceipt({ hash });
      settled += batch.length;
      console.log(`settled ${batch.length} batch(es) [${batch.join(", ")}] gas ${rc.gasUsed} status ${rc.status} (total ${settled}) balance ${formatEther(await pub.getBalance({ address: account.address }))} MON`);
    }
  } catch (e: any) {
    console.error("keeper error:", e.shortMessage ?? e.message);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
