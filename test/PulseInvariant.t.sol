// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PulseExchange, IERC20} from "../src/PulseExchange.sol";
import {MockToken} from "../src/MockToken.sol";

/// Random sequences of orders, block advances, settles and claims by several accounts.
contract PulseHandler is Test {
    PulseExchange public ex;
    MockToken public base;
    MockToken public quote;
    address[] public actors;

    constructor(PulseExchange _ex, MockToken _base, MockToken _quote) {
        ex = _ex;
        base = _base;
        quote = _quote;
        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(0xA000 + i));
            actors.push(a);
            base.mint(a, 1e30);
            quote.mint(a, 1e30);
            vm.startPrank(a);
            base.approve(address(ex), type(uint256).max);
            quote.approve(address(ex), type(uint256).max);
            vm.stopPrank();
        }
    }

    function submit(uint256 actorSeed, bool buy, uint8 tick, uint96 amount) external {
        vm.prank(actors[actorSeed % actors.length]);
        ex.submitOrder(
            buy ? PulseExchange.Side.Buy : PulseExchange.Side.Sell, tick % 64, uint128(bound(amount, 1, 1_000 ether))
        );
    }

    function nextBlock(uint8 n) external {
        vm.roll(block.number + 1 + (n % 3));
    }

    function settleAll() external {
        uint256 n = ex.activeBatchCount();
        uint64[] memory list = new uint64[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = ex.activeBatches(i);
        }
        ex.settleMany(list);
    }

    function claimSome(uint8 count) external {
        uint256 n = ex.ordersLength();
        uint256 take = n < uint256(count) % 8 + 1 ? n : uint256(count) % 8 + 1;
        uint256[] memory ids = new uint256[](take);
        for (uint256 i; i < take; ++i) {
            ids[i] = n - 1 - i;
        }
        ex.claimMany(ids);
    }
}

contract PulseInvariantTest is Test {
    PulseExchange ex;
    MockToken base;
    MockToken quote;
    PulseHandler handler;

    function setUp() public {
        base = new MockToken("Base", "BASE");
        quote = new MockToken("Quote", "USD");
        ex = new PulseExchange(IERC20(address(base)), IERC20(address(quote)));
        handler = new PulseHandler(ex, base, quote);
        vm.roll(100);
        targetContract(address(handler));
    }

    /// The exchange always holds at least what it owes: unclaimed escrow of open batches plus the
    /// payouts of cleared batches, for both tokens. Rounding must never make it insolvent.
    function invariant_alwaysSolvent() public view {
        uint256 baseOwed;
        uint256 quoteOwed;
        uint256 n = ex.ordersLength();
        for (uint256 id; id < n; ++id) {
            (address owner, uint64 batch, uint8 tick, PulseExchange.Side side, bool claimed, uint128 amount,) =
                ex.orders(id);
            owner;
            if (claimed) continue;
            PulseExchange.OrderView[] memory v = ex.ordersOf(owner, n);
            // find this order in the owner's list to learn whether its batch is settled
            bool settled;
            uint256 baseOut;
            uint256 quoteOut;
            for (uint256 j; j < v.length; ++j) {
                if (v[j].id == id) {
                    settled = v[j].settled;
                    baseOut = v[j].baseOut;
                    quoteOut = v[j].quoteOut;
                    break;
                }
            }
            batch;
            if (settled) {
                baseOwed += baseOut;
                quoteOwed += quoteOut;
            } else if (side == PulseExchange.Side.Buy) {
                quoteOwed += (uint256(amount) * ex.tickPrice(tick) + 1e18 - 1) / 1e18;
            } else {
                baseOwed += amount;
            }
        }
        assertGe(base.balanceOf(address(ex)), baseOwed, "base insolvent");
        assertGe(quote.balanceOf(address(ex)), quoteOwed, "quote insolvent");
    }

    /// Each account's linked list of orders is complete: it visits exactly that owner's orders.
    function invariant_ownerIndexComplete() public view {
        uint256 n = ex.ordersLength();
        uint256 viaIndex;
        for (uint256 i; i < 4; ++i) {
            viaIndex += ex.ordersOf(handler.actors(i), n).length;
        }
        assertEq(viaIndex, n, "index misses orders");
    }
}
