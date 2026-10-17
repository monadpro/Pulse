// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title PulseExchange
/// @notice On-chain frequent batch auction. Every block is one batch: all orders
///         submitted in the same block clear at a single uniform price, so
///         ordering inside the block earns nothing (no front-running / sandwiching).
/// @dev Orders are aggregated into fixed price ticks on submit, so `settle` is a
///      fixed 64-tick scan with constant gas, independent of the number of orders.
contract PulseExchange {
    uint256 public constant TICKS = 64;
    uint256 public constant MIN_PRICE = 0.5 ether; // quote per 1 base at tick 0
    uint256 public constant TICK_SIZE = 0.01 ether;
    uint256 private constant WAD = 1e18;

    IERC20 public immutable base;
    IERC20 public immutable quote;

    enum Side {
        Buy,
        Sell
    }

    struct Order {
        address owner;
        uint64 batch;
        uint8 tick;
        Side side;
        bool claimed;
        uint128 amount; // base units
    }

    struct Batch {
        bool settled;
        uint8 clearTick;
        uint128 volume; // matched base volume
        uint128 eligibleBids; // base demand at tick >= clearTick
        uint128 eligibleAsks; // base supply at tick <= clearTick
        uint128 quoteVolume; // quote paid by buyers / received by sellers in total
        uint128[TICKS] bids; // base amount per tick (buy limit = max price)
        uint128[TICKS] asks; // base amount per tick (sell limit = min price)
    }

    mapping(uint64 => Batch) private batches;
    Order[] public orders;

    event OrderSubmitted(uint256 indexed orderId, uint64 indexed batch, address indexed owner, Side side, uint8 tick, uint128 amount);
    event BatchSettled(uint64 indexed batch, uint8 clearTick, uint256 clearPrice, uint128 volume);
    event Claimed(uint256 indexed orderId, address indexed owner, uint128 filled, uint256 baseOut, uint256 quoteOut);

    constructor(IERC20 _base, IERC20 _quote) {
        base = _base;
        quote = _quote;
    }

    function tickPrice(uint8 tick) public pure returns (uint256) {
        return MIN_PRICE + uint256(tick) * TICK_SIZE;
    }

    function ordersLength() external view returns (uint256) {
        return orders.length;
    }

    function getBatch(uint64 batch)
        external
        view
        returns (bool settled, uint8 clearTick, uint128 volume, uint128[TICKS] memory bids, uint128[TICKS] memory asks)
    {
        Batch storage b = batches[batch];
        return (b.settled, b.clearTick, b.volume, b.bids, b.asks);
    }

    /// @notice Submit an order into the current block's batch.
    function submitOrder(Side side, uint8 tick, uint128 amount) public returns (uint256 id) {
        require(tick < TICKS, "tick");
        require(amount > 0, "amount");
        uint64 batch = uint64(block.number);
        Batch storage b = batches[batch];
        require(!b.settled, "settled");

        if (side == Side.Buy) {
            b.bids[tick] += amount;
            require(quote.transferFrom(msg.sender, address(this), _quoteForUp(amount, tickPrice(tick))), "pay quote");
        } else {
            b.asks[tick] += amount;
            require(base.transferFrom(msg.sender, address(this), amount), "pay base");
        }

        id = orders.length;
        orders.push(Order(msg.sender, batch, tick, side, false, amount));
        emit OrderSubmitted(id, batch, msg.sender, side, tick, amount);
    }

    /// @notice Submit many orders in one transaction (for bots / load tests).
    function submitOrders(Side[] calldata sides, uint8[] calldata ticks, uint128[] calldata amounts) external {
        require(sides.length == ticks.length && ticks.length == amounts.length, "len");
        for (uint256 i; i < sides.length; ++i) {
            submitOrder(sides[i], ticks[i], amounts[i]);
        }
    }

    /// @notice Clear a finished batch at the uniform price that maximizes matched volume.
    ///         Callable by anyone; gas is constant (fixed 64-tick scan).
    function settle(uint64 batch) external {
        require(batch < block.number, "open");
        Batch storage b = batches[batch];
        require(!b.settled, "settled");

        // demand(i) = bids at tick >= i ; supply(i) = asks at tick <= i
        uint128[TICKS] memory bids = b.bids;
        uint128[TICKS] memory asks = b.asks;

        uint256 demand;
        for (uint256 i; i < TICKS; ++i) {
            demand += bids[i];
        }

        uint256 supply;
        uint256 bestVolume;
        uint256 bestTick;
        uint256 bestDemand;
        uint256 bestSupply;
        for (uint256 i; i < TICKS; ++i) {
            supply += asks[i];
            // demand currently = sum of bids at tick >= i
            uint256 matched = demand < supply ? demand : supply;
            if (matched > bestVolume) {
                bestVolume = matched;
                bestTick = i;
                bestDemand = demand;
                bestSupply = supply;
            }
            demand -= bids[i];
        }

        b.settled = true;
        b.clearTick = uint8(bestTick);
        b.volume = uint128(bestVolume);
        b.eligibleBids = uint128(bestDemand);
        b.eligibleAsks = uint128(bestSupply);
        b.quoteVolume = uint128(_quoteFor(bestVolume, tickPrice(uint8(bestTick))));
        emit BatchSettled(batch, uint8(bestTick), tickPrice(uint8(bestTick)), uint128(bestVolume));
    }

    /// @notice Settle an order: pay out fills and refund unused escrow.
    function claim(uint256 orderId) external {
        Order storage o = orders[orderId];
        require(!o.claimed, "claimed");
        Batch storage b = batches[o.batch];
        require(b.settled, "unsettled");
        o.claimed = true;

        uint128 filled;
        uint256 baseOut;
        uint256 quoteOut;

        // Rounding is chosen so the contract never owes more than it holds:
        // buyers fill/pay and sellers sell/receive round in the contract's favour.
        if (o.side == Side.Buy) {
            uint256 cost;
            if (b.volume > 0 && o.tick >= b.clearTick) {
                filled = uint128(uint256(o.amount) * b.volume / b.eligibleBids);
                cost = _divUp(uint256(o.amount) * b.quoteVolume, b.eligibleBids);
            }
            baseOut = filled;
            quoteOut = _quoteForUp(o.amount, tickPrice(o.tick)) - cost;
        } else {
            uint256 sold;
            if (b.volume > 0 && o.tick <= b.clearTick) {
                sold = _divUp(uint256(o.amount) * b.volume, b.eligibleAsks);
                quoteOut = uint256(o.amount) * b.quoteVolume / b.eligibleAsks;
            }
            filled = uint128(sold);
            baseOut = o.amount - sold;
        }

        if (baseOut > 0) require(base.transfer(o.owner, baseOut), "base out");
        if (quoteOut > 0) require(quote.transfer(o.owner, quoteOut), "quote out");
        emit Claimed(orderId, o.owner, filled, baseOut, quoteOut);
    }

    function _quoteFor(uint256 baseAmount, uint256 price) private pure returns (uint256) {
        return baseAmount * price / WAD;
    }

    function _quoteForUp(uint256 baseAmount, uint256 price) private pure returns (uint256) {
        return _divUp(baseAmount * price, WAD);
    }

    function _divUp(uint256 a, uint256 d) private pure returns (uint256) {
        return (a + d - 1) / d;
    }
}
