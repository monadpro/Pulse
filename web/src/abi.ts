import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function faucet()",
]);

export const exchangeAbi = parseAbi([
  "function TICKS() view returns (uint256)",
  "function tickPrice(uint8) pure returns (uint256)",
  "function ordersLength() view returns (uint256)",
  "function orders(uint256) view returns (address owner, uint64 batch, uint8 tick, uint8 side, bool claimed, uint128 amount)",
  "function getBatch(uint64) view returns (bool settled, uint8 clearTick, uint128 volume, uint128[64] bids, uint128[64] asks)",
  "function submitOrder(uint8 side, uint8 tick, uint128 amount) returns (uint256)",
  "function settle(uint64 batch)",
  "function claim(uint256 orderId)",
  "function previewClaim(uint256) view returns (uint128 filled, uint256 baseOut, uint256 quoteOut)",
  "event OrderSubmitted(uint256 indexed orderId, uint64 indexed batch, address indexed owner, uint8 side, uint8 tick, uint128 amount)",
  "event BatchSettled(uint64 indexed batch, uint8 clearTick, uint256 clearPrice, uint128 volume)",
]);

// Monad charges gas_limit, not gas used, so limits are fixed just above measured usage.
export const GAS = {
  approve: 70_000n,
  faucet: 90_000n,
  submitOrder: 240_000n,
  settle: 200_000n,
  claim: 170_000n,
} as const;

export const labAbi = parseAbi([
  "function lastAmm() view returns (uint256 victimFair, uint256 victimGot, int256 attackerProfit)",
  "function pulseReport() view returns (uint256 clearPrice, uint256 victimBase, uint256 victimQuotePaid, int256 attackerProfit)",
  "function round() view returns (uint64 batch, uint256 attackerBuy, uint256 victimBuy, uint256 attackerSell, uint256 maker, uint128 victimAmount, uint128 attackerAmount)",
  "function runAmm(uint256 victimQuote, uint256 attackerQuote)",
  "function runPulse(uint128 victimAmount, uint128 attackerAmount)",
  "function finishPulse()",
]);

export const LAB_GAS = { runAmm: 450_000n, runPulse: 1_000_000n, finishPulse: 450_000n } as const;
