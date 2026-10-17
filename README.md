# Pulse

On-chain **frequent batch auction** DEX for Monad. Every block is one batch: all orders
submitted in the same block clear at a single uniform price, so transaction ordering
inside the block earns nothing — no front-running, no sandwiching.

## How it works
- `submitOrder(side, tick, amount)` escrows funds and aggregates the order into one of 64 fixed price ticks.
- `settle(batch)` (anyone, after the block ends) scans the 64 ticks once and picks the price that maximizes matched volume. Gas is constant (~170k) regardless of order count.
- `claim(orderId)` pays out fills at the uniform price (pro-rata on the long side) and refunds unused escrow.
- Rounding always favors the contract, so it can never owe more than it holds (fuzz-tested).

## Dev
```sh
forge test -vv
```
Config follows the Monad docs (`network = "monad"`, Foundry >= 1.8).
