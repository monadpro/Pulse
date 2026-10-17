// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./PulseExchange.sol";

/// @notice Tiny constant-product AMM (x*y=k, 0.3% fee). Exists only as the "before" picture
///         in the sandwich-attack comparison.
contract SimpleAMM {
    IERC20 public immutable base;
    IERC20 public immutable quote;
    uint256 public baseReserve;
    uint256 public quoteReserve;

    constructor(IERC20 _base, IERC20 _quote) {
        base = _base;
        quote = _quote;
    }

    function addLiquidity(uint256 baseAmt, uint256 quoteAmt) external {
        require(base.transferFrom(msg.sender, address(this), baseAmt), "base");
        require(quote.transferFrom(msg.sender, address(this), quoteAmt), "quote");
        baseReserve += baseAmt;
        quoteReserve += quoteAmt;
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        uint256 inWithFee = amountIn * 997;
        return inWithFee * reserveOut / (reserveIn * 1000 + inWithFee);
    }

    function quoteBaseOut(uint256 quoteIn) external view returns (uint256) {
        return getAmountOut(quoteIn, quoteReserve, baseReserve);
    }

    function swapQuoteForBase(uint256 quoteIn) external returns (uint256 baseOut) {
        baseOut = getAmountOut(quoteIn, quoteReserve, baseReserve);
        require(quote.transferFrom(msg.sender, address(this), quoteIn), "in");
        quoteReserve += quoteIn;
        baseReserve -= baseOut;
        require(base.transfer(msg.sender, baseOut), "out");
    }

    function swapBaseForQuote(uint256 baseIn) external returns (uint256 quoteOut) {
        quoteOut = getAmountOut(baseIn, baseReserve, quoteReserve);
        require(base.transferFrom(msg.sender, address(this), baseIn), "in");
        baseReserve += baseIn;
        quoteReserve -= quoteOut;
        require(quote.transfer(msg.sender, quoteOut), "out");
    }
}
