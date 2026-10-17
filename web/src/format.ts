import { formatEther } from "viem";
import { chain } from "./chain";

export const explorer = chain.blockExplorers?.default.url;
export const fmt = (v: bigint) => Number(formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 2 });
export const num = (v: bigint) => Number(formatEther(v));
export const fmtN = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
export const tickPrice = (t: number) => 0.5 + t * 0.01;

export type CommitState = "Proposed" | "Voted" | "Finalized" | "Verified";
export const RANK: Record<CommitState, number> = { Proposed: 0, Voted: 1, Finalized: 2, Verified: 3 };
export const later = (a: CommitState | undefined, b: CommitState) => (a && RANK[a] >= RANK[b] ? a : b);

/** What a block's colour means. Block confirmation is NOT the same thing as the batch being cleared. */
export const STATE_INFO: Record<CommitState, { label: string; meaning: string }> = {
  Proposed: { label: "已提议 Proposed", meaning: "区块刚产生，还在等验证者投票，理论上还可能被放弃" },
  Voted: { label: "已投票 Voted", meaning: "已获得验证者投票，基本确定，但还不是最终" },
  Finalized: { label: "已最终确认 Finalized", meaning: "已最终确认，不会被回滚" },
  Verified: { label: "已验证 Verified", meaning: "状态也已最终验证，是最晚的确认阶段" },
};

/** Estimate from distance to the head. This is an inference, never a node-reported state. */
export const derivedState = (block: number, head: number): CommitState =>
  head - block >= 2 ? "Finalized" : head - block === 1 ? "Voted" : "Proposed";

export interface MyOrder {
  id: number;
  batch: number;
  tick: number;
  side: number;
  claimed: boolean;
  amount: bigint;
  settled: boolean;
  filled: bigint;
  baseOut: bigint;
  quoteOut: bigint;
}
