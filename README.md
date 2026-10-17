# Pulse

On-chain **frequent batch auction** DEX for Monad. Every block is one batch: all orders
submitted in the same block clear at a single uniform price, so transaction ordering
inside the block earns nothing — no front-running, no sandwiching.

## How it works
- `submitOrder(side, tick, amount)` escrows funds and aggregates the order into one of 64 fixed price ticks.
- `settle(batch)` (anyone, after the block ends) scans the 64 ticks once and picks the price that maximizes matched volume. Gas is constant (~155–175k) regardless of order count.
- `claim(orderId)` pays out fills at the uniform price (pro-rata on the long side) and refunds unused escrow.
- Rounding always favors the contract, so it can never owe more than it holds (fuzz-tested).

## Docs
- [User guide](docs/USER_GUIDE.md) — step-by-step for beginners (Chinese)
- [Attack comparison: AMM vs Pulse](docs/ATTACK_COMPARISON.md) — what the demo panel shows and how to read it
- [Team testing guide](docs/TESTING.md) — test checklist, known issues, how to report
- [Plan](PLAN.md) — goals, design, task status

## Scale
Measured, not promised:

- **Monad testnet** (`web/scripts/stress.ts`, run on the verified deployment): **600 orders confirmed in 3.1 s**, with **450 orders in a single block**. Clearing that block needs **172,498 gas**, against **154,264 gas** for a block of 150 orders: the cost of `settle` does not grow with the number of orders (it is a fixed 64-slot scan). Monad receipts report the gas limit as `gasUsed`, so these numbers come from `eth_estimateGas`.
- `forge test --match-contract PulseScaleTest -vv`: **1,000 orders in one block**, `settle` ~188k gas (the very first settle also initialises the batch list; steady state ~153k), and all 1,000 claims pay out without the contract ever being insolvent.
- `forge test --match-contract PulseInvariantTest`: random sequences of orders, settles and claims keep the exchange solvent for both tokens, and every account's order list stays complete.
- `submitOrders` batches many orders into one transaction (~52k gas per order instead of ~230k for a single cold `submitOrder`).
- **Storage layout for Monad**: the bid and ask of a tick share one slot, and a batch's 64-slot book starts at a 128-slot-aligned base, so a cold settle reads one storage page. This cut a steady-state settle from ~170k to ~153k gas in Foundry's Monad mode.
- Throughput is limited by the public RPC (~15 requests/sec) and by MON for gas, not by the contract.

```sh
cd web
ORDERS=600 PER_TX=150 npx tsx scripts/stress.ts   # sends the batches back to back, then clears each block
npx tsx scripts/keeper.ts                         # optional: auto-settle every finished batch AND claim for users (spend cap MAX_SPEND, default 0.8 MON)
```

## Dev
```sh
forge test -vv
```
Config follows the Monad docs (`network = "monad"`, Foundry >= 1.8).

## License
MIT, see [LICENSE](LICENSE).

## Deployed on Monad testnet (chainId 10143)
All contracts are verified on MonadVision (Sourcify, exact match). Live app: https://monadpro.github.io/Pulse/

| Contract | Address |
|---|---|
| PulseExchange | [`0x14C0B4328038698B75fdC31D3c19853F8249c29f`](https://testnet.monadvision.com/address/0x14C0B4328038698B75fdC31D3c19853F8249c29f) |
| pMON (base) | [`0xA55556b821966e565102DADee57Fb9Fac297c2A5`](https://testnet.monadvision.com/address/0xA55556b821966e565102DADee57Fb9Fac297c2A5) |
| pUSD (quote) | [`0x3e28F0cE40D6Ec7726E424b194B4E2d7F9cb4924`](https://testnet.monadvision.com/address/0x3e28F0cE40D6Ec7726E424b194B4E2d7F9cb4924) |
| SimpleAMM (demo) | [`0xdc97a0C72Bbb08e22d0D04346A80Ff7F0dA7225D`](https://testnet.monadvision.com/address/0xdc97a0C72Bbb08e22d0D04346A80Ff7F0dA7225D) |
| AttackLab (demo) | [`0x47B5922CA9FaA65134875110E0c4183363BC0750`](https://testnet.monadvision.com/address/0x47B5922CA9FaA65134875110E0c4183363BC0750) |
