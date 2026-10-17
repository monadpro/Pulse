# Pulse

On-chain **frequent batch auction** DEX for Monad. Every block is one batch: all orders
submitted in the same block clear at a single uniform price, so transaction ordering
inside the block earns nothing — no front-running, no sandwiching.

## How it works
- `submitOrder(side, tick, amount)` escrows funds and aggregates the order into one of 64 fixed price ticks.
- `settle(batch)` (anyone, after the block ends) scans the 64 ticks once and picks the price that maximizes matched volume. Gas is constant (~170k) regardless of order count.
- `claim(orderId)` pays out fills at the uniform price (pro-rata on the long side) and refunds unused escrow.
- Rounding always favors the contract, so it can never owe more than it holds (fuzz-tested).

## Docs
- [User guide](docs/USER_GUIDE.md) — step-by-step for beginners (Chinese)
- [Team testing guide](docs/TESTING.md) — test checklist, known issues, how to report
- [Plan](PLAN.md) — goals, design, task status

## Scale
- `forge test --match-contract PulseScaleTest -vv`: **1,000 orders in one block**, `settle` costs **170,173 gas** (a fixed 64-tick scan, same as for 2 orders), and all 1,000 claims pay out without the contract ever being insolvent.
- `submitOrders` batches many orders into one transaction (~47k gas per order instead of ~200k for a single `submitOrder`).
- Stress demo against any RPC (`web/scripts/stress.ts`): sends the batches back to back with local nonces so they land in the same block, then clears each batch and prints orders per block and settle gas.
  ```sh
  cd web && ORDERS=400 PER_TX=100 npx tsx scripts/stress.ts   # RPC_URL=... to target another chain
  ```
  On a local anvil this put 400 orders into one block and cleared them for 161,531 gas.

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
