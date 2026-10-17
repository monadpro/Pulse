import { createPublicClient, http, webSocket, type Address } from "viem";
import { chain } from "./chain";
import deployments from "./deployments.json";

export const publicHttp = createPublicClient({ chain, transport: http(undefined, { batch: true }) });
export const publicWs = createPublicClient({ chain, transport: webSocket() });

export const addrs = deployments as { base: Address; quote: Address; exchange: Address; amm: Address; lab: Address };
export const deployed = addrs.exchange !== "0x0000000000000000000000000000000000000000";
