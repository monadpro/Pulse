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

## Dev
```sh
forge test -vv
```
Config follows the Monad docs (`network = "monad"`, Foundry >= 1.8).

## Deployed on Monad testnet (chainId 10143)
All contracts are verified on MonadVision (Sourcify, exact match). Live app: https://monadpro.github.io/Pulse/

| Contract | Address |
|---|---|
| PulseExchange | [`0xd361909697fEf21D8b8831DC7b7A40139511FBC0`](https://testnet.monadvision.com/address/0xd361909697fEf21D8b8831DC7b7A40139511FBC0) |
| pMON (base) | [`0xD84A85Df94e403bEc6f601F4f9c94832E87435E2`](https://testnet.monadvision.com/address/0xD84A85Df94e403bEc6f601F4f9c94832E87435E2) |
| pUSD (quote) | [`0xC54528fe4cA6bb411DEa1AEFa2129eAc907866eA`](https://testnet.monadvision.com/address/0xC54528fe4cA6bb411DEa1AEFa2129eAc907866eA) |
| SimpleAMM (demo) | [`0xC9BFD3aBE46a342F28BceCE840e53c4b7dc0D68d`](https://testnet.monadvision.com/address/0xC9BFD3aBE46a342F28BceCE840e53c4b7dc0D68d) |
| AttackLab (demo) | [`0xfd65ac9EC74f588a1F3799977d1ddF3c2Ed417DC`](https://testnet.monadvision.com/address/0xfd65ac9EC74f588a1F3799977d1ddF3c2Ed417DC) |
