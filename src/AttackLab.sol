// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PulseExchange, IERC20} from "./PulseExchange.sol";
import {SimpleAMM} from "./SimpleAMM.sol";

/// @notice Demo harness: simulates a malicious block builder that can reorder transactions inside a
///         block, running the same sandwich (attacker buys, victim buys, attacker sells) against an
///         AMM and against Pulse so the two outcomes can be compared side by side.
contract AttackLab {
    uint8 private constant MAX_TICK = 63;
    uint8 private constant MAKER_TICK = 50; // price 1.00
    uint128 private constant MAKER_LIQUIDITY = 20_000 ether;

    IERC20 public immutable base;
    IERC20 public immutable quote;
    SimpleAMM public immutable amm;
    PulseExchange public immutable pulse;

    struct AmmReport {
        uint256 victimFair; // base the victim would get with no attacker
        uint256 victimGot; // base the victim actually got
        int256 attackerProfit; // quote
    }

    struct PulseRound {
        uint64 batch;
        uint256 attackerBuy;
        uint256 victimBuy;
        uint256 attackerSell;
        uint256 maker;
        uint128 victimAmount;
        uint128 attackerAmount;
    }

    struct PulseReport {
        uint256 clearPrice; // quote per base, 1e18
        uint256 victimBase;
        uint256 victimQuotePaid;
        int256 attackerProfit; // quote, valued at the clearing price
    }

    AmmReport public lastAmm;
    PulseRound public round;

    constructor(IERC20 _base, IERC20 _quote, SimpleAMM _amm, PulseExchange _pulse) {
        base = _base;
        quote = _quote;
        amm = _amm;
        pulse = _pulse;
        _base.approve(address(_amm), type(uint256).max);
        _quote.approve(address(_amm), type(uint256).max);
        _base.approve(address(_pulse), type(uint256).max);
        _quote.approve(address(_pulse), type(uint256).max);
    }

    /// @notice Sandwich a victim's AMM swap. Needs the lab to hold quote and base inventory.
    function runAmm(uint256 victimQuote, uint256 attackerQuote) external returns (AmmReport memory r) {
        r.victimFair = amm.quoteBaseOut(victimQuote);
        uint256 quoteBefore = quote.balanceOf(address(this));

        uint256 attackerBase = amm.swapQuoteForBase(attackerQuote); // 1. attacker front-runs
        r.victimGot = amm.swapQuoteForBase(victimQuote); // 2. victim trades at the worse price
        amm.swapBaseForQuote(attackerBase); // 3. attacker back-runs

        // the victim is simulated by this contract too, so add back what the "victim" paid
        r.attackerProfit = int256(quote.balanceOf(address(this))) - int256(quoteBefore) + int256(victimQuote);
        lastAmm = r;
    }

    /// @notice Step 1 of the Pulse run: all four orders land in the same block (same batch).
    function runPulse(uint128 victimAmount, uint128 attackerAmount) external {
        PulseExchange.Side buy = PulseExchange.Side.Buy;
        PulseExchange.Side sell = PulseExchange.Side.Sell;
        round = PulseRound({
            batch: uint64(block.number),
            maker: pulse.submitOrder(sell, MAKER_TICK, MAKER_LIQUIDITY), // ordinary liquidity at 1.00
            attackerBuy: pulse.submitOrder(buy, MAX_TICK, attackerAmount), // 1. attacker front-runs
            victimBuy: pulse.submitOrder(buy, MAX_TICK, victimAmount), // 2. victim, loose limit price
            attackerSell: pulse.submitOrder(sell, 0, attackerAmount), // 3. attacker back-runs
            victimAmount: victimAmount,
            attackerAmount: attackerAmount
        });
    }

    /// @notice Step 2 (a later block): settle the batch and pay everything out.
    function finishPulse() external {
        PulseRound memory r = round;
        pulse.settle(r.batch);
        pulse.claim(r.maker);
        pulse.claim(r.attackerBuy);
        pulse.claim(r.victimBuy);
        pulse.claim(r.attackerSell);
    }

    function pulseReport() external view returns (PulseReport memory rep) {
        PulseRound memory r = round;
        (, uint8 clearTick,,,) = pulse.getBatch(r.batch);
        rep.clearPrice = pulse.tickPrice(clearTick);

        (uint128 vFilled,, uint256 vQuoteBack) = pulse.previewClaim(r.victimBuy);
        rep.victimBase = vFilled;
        rep.victimQuotePaid = _escrow(r.victimAmount) - vQuoteBack;

        (, uint256 buyBase, uint256 buyQuote) = pulse.previewClaim(r.attackerBuy);
        (, uint256 sellBase, uint256 sellQuote) = pulse.previewClaim(r.attackerSell);
        int256 netQuote = int256(buyQuote + sellQuote) - int256(_escrow(r.attackerAmount));
        int256 netBase = int256(buyBase + sellBase) - int256(uint256(r.attackerAmount));
        rep.attackerProfit = netQuote + netBase * int256(rep.clearPrice) / 1e18;
    }

    function _escrow(uint256 amount) private view returns (uint256) {
        return (amount * pulse.tickPrice(MAX_TICK) + 1e18 - 1) / 1e18;
    }
}
