import { createPublicClient, http, webSocket, type Address } from "viem";
import { chain } from "./chain";
import deployments from "./deployments.json";

export const publicHttp = createPublicClient({ chain, transport: http(undefined, { batch: true }) });
export const publicWs = createPublicClient({ chain, transport: webSocket() });

export const addrs = deployments as { base: Address; quote: Address; exchange: Address; amm: Address; lab: Address };
export const deployed = addrs.exchange !== "0x0000000000000000000000000000000000000000";

type Call = { address: Address; abi: any; functionName: string; args?: readonly unknown[] };

/** Read many contract values in ONE RPC request (Multicall3), falling back to parallel calls on chains without it. */
export async function readMany(calls: Call[]): Promise<any[]> {
  if (calls.length === 0) return [];
  if (chain.contracts?.multicall3) {
    return (await publicHttp.multicall({ contracts: calls as any, allowFailure: false })) as any[];
  }
  return Promise.all(calls.map((c) => publicHttp.readContract(c as any)));
}
