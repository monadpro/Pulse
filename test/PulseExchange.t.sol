// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PulseExchange, IERC20} from "../src/PulseExchange.sol";
import {MockToken} from "../src/MockToken.sol";

contract PulseExchangeTest is Test {
    MockToken base;
    MockToken quote;
    PulseExchange ex;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);

    function setUp() public {
        base = new MockToken("Base", "BASE");
        quote = new MockToken("Quote", "USD");
        ex = new PulseExchange(IERC20(address(base)), IERC20(address(quote)));
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < users.length; ++i) {
            base.mint(users[i], 1_000_000 ether);
            quote.mint(users[i], 1_000_000 ether);
            vm.startPrank(users[i]);
            base.approve(address(ex), type(uint256).max);
            quote.approve(address(ex), type(uint256).max);
            vm.stopPrank();
        }
        vm.roll(100);
    }

    function _submit(address who, PulseExchange.Side side, uint8 tick, uint128 amt) internal returns (uint256) {
        vm.prank(who);
        return ex.submitOrder(side, tick, amt);
    }

    function test_uniformPrice() public {
        // price(tick 50) = 1.0, price(tick 40) = 0.9, price(tick 60) = 1.1
        uint256 b1 = _submit(alice, PulseExchange.Side.Buy, 60, 100 ether); // willing to pay up to 1.1
        uint256 s1 = _submit(bob, PulseExchange.Side.Sell, 40, 100 ether); // willing to sell from 0.9
        vm.roll(block.number + 1);
        ex.settle(100);
        (, uint8 clearTick, uint128 vol,,) = ex.getBatch(100);
        assertEq(vol, 100 ether);
        // every tick in [40,60] clears the same volume; first max wins
        assertEq(clearTick, 40);

        uint256 qa = quote.balanceOf(alice);
        uint256 ba = base.balanceOf(alice);
        ex.claim(b1);
        // buyer paid the clearing price (0.9), not their 1.1 limit
        assertEq(base.balanceOf(alice) - ba, 100 ether);
        assertEq(quote.balanceOf(alice) - qa, 100 ether * 11 / 10 - 90 ether);

        uint256 qb = quote.balanceOf(bob);
        ex.claim(s1);
        assertEq(quote.balanceOf(bob) - qb, 90 ether);
    }

    function test_noCross_refundsEverything() public {
        uint256 b1 = _submit(alice, PulseExchange.Side.Buy, 10, 50 ether);
        uint256 s1 = _submit(bob, PulseExchange.Side.Sell, 50, 50 ether);
        vm.roll(block.number + 1);
        ex.settle(100);
        (,, uint128 vol,,) = ex.getBatch(100);
        assertEq(vol, 0);
        uint256 qa = quote.balanceOf(alice);
        uint256 bb = base.balanceOf(bob);
        ex.claim(b1);
        ex.claim(s1);
        assertEq(quote.balanceOf(alice) - qa, 50 ether * 60 / 100); // 0.6 price at tick 10
        assertEq(base.balanceOf(bob) - bb, 50 ether);
        assertEq(base.balanceOf(address(ex)), 0);
        assertEq(quote.balanceOf(address(ex)), 0);
    }

    function test_proRataOnLongSide() public {
        uint256 b1 = _submit(alice, PulseExchange.Side.Buy, 50, 60 ether);
        uint256 b2 = _submit(carol, PulseExchange.Side.Buy, 50, 140 ether);
        uint256 s1 = _submit(bob, PulseExchange.Side.Sell, 50, 100 ether);
        vm.roll(block.number + 1);
        ex.settle(100);
        uint256 ba = base.balanceOf(alice);
        uint256 bc = base.balanceOf(carol);
        ex.claim(b1);
        ex.claim(b2);
        ex.claim(s1);
        assertEq(base.balanceOf(alice) - ba, 30 ether);
        assertEq(base.balanceOf(carol) - bc, 70 ether);
    }

    function test_sandwichGainsNothing() public {
        // Attacker (carol) buys before the victim and sells after, all in one block.
        // Every fill clears at the single uniform price, so the round trip cannot profit.
        uint256 q0 = quote.balanceOf(carol);
        uint256 b0 = base.balanceOf(carol);
        _submit(bob, PulseExchange.Side.Sell, 50, 1000 ether);
        uint256 front = _submit(carol, PulseExchange.Side.Buy, 63, 200 ether);
        _submit(alice, PulseExchange.Side.Buy, 63, 100 ether); // victim
        uint256 back = _submit(carol, PulseExchange.Side.Sell, 0, 200 ether);
        vm.roll(block.number + 1);
        ex.settle(100);
        ex.claim(front);
        ex.claim(back);
        (, uint8 ct,,,) = ex.getBatch(100);
        uint256 p = ex.tickPrice(ct);
        int256 worthBefore = int256(q0) + int256(b0 * p / 1e18);
        int256 worthAfter = int256(quote.balanceOf(carol)) + int256(base.balanceOf(carol) * p / 1e18);
        assertLe(worthAfter, worthBefore);
    }

    function test_settleGasIsConstant() public {
        _submit(alice, PulseExchange.Side.Buy, 50, 1 ether);
        _submit(bob, PulseExchange.Side.Sell, 50, 1 ether);
        vm.roll(block.number + 1);
        uint256 g0 = gasleft();
        ex.settle(100);
        uint256 small = g0 - gasleft();

        vm.roll(block.number + 1);
        uint64 batch2 = uint64(block.number);
        for (uint256 i; i < 100; ++i) {
            _submit(alice, PulseExchange.Side.Buy, uint8(i % 64), 1 ether);
            _submit(bob, PulseExchange.Side.Sell, uint8((i * 7) % 64), 1 ether);
        }
        vm.roll(block.number + 1);
        uint256 g1 = gasleft();
        ex.settle(batch2);
        uint256 big = g1 - gasleft();
        emit log_named_uint("settle gas (2 orders)", small);
        emit log_named_uint("settle gas (200 orders)", big);
        assertApproxEqRel(big, small, 0.05e18);
    }

    function test_cannotSettleOpenBatch() public {
        _submit(alice, PulseExchange.Side.Buy, 50, 1 ether);
        vm.expectRevert(bytes("open"));
        ex.settle(100);
    }

    function testFuzz_solvent(uint8 t1, uint8 t2, uint8 t3, uint96 a1, uint96 a2, uint96 a3) public {
        t1 %= 64;
        t2 %= 64;
        t3 %= 64;
        uint128 x1 = uint128(bound(a1, 1, 1000 ether));
        uint128 x2 = uint128(bound(a2, 1, 1000 ether));
        uint128 x3 = uint128(bound(a3, 1, 1000 ether));
        uint256 o1 = _submit(alice, PulseExchange.Side.Buy, t1, x1);
        uint256 o2 = _submit(bob, PulseExchange.Side.Sell, t2, x2);
        uint256 o3 = _submit(carol, PulseExchange.Side.Buy, t3, x3);
        vm.roll(block.number + 1);
        ex.settle(100);
        ex.claim(o1);
        ex.claim(o2);
        ex.claim(o3); // would revert if the contract were insolvent
    }
}
