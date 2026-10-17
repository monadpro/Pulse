// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title PulseExchange
/// @notice On-chain frequent batch auction. Every block is one batch: all orders
///         submitted in the same block clear at a single uniform price, so
///         ordering inside the block earns nothing (no front-running / sandwiching).
/// @dev Orders are aggregated into fixed price ticks on submit, so `settle` is a
///      fixed 64-slot scan with constant gas, independent of the number of orders.
///      Storage is laid out for Monad's page-based storage: both sides of a tick share one slot
///      (bid in the low 128 bits, ask in the high 128 bits), so a batch's whole book is 64 contiguous
///      slots instead of 128. The book lives at a 128-slot-aligned base derived from the batch number, so all
///      64 slots sit in a single storage page: a cold settle pays for one page, not two.
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
        uint64 prevByOwner; // id + 1 of the owner's previous order (0 = none): a per-user linked list
    }

    struct Batch {
        bool settled;
        uint8 clearTick;
        uint32 orderCount;
        uint128 volume; // matched base volume
        uint128 totalBids; // total buy size, in base units
        uint128 totalAsks; // total sell size, in base units
        uint128 eligibleBids; // base demand at tick >= clearTick
        uint128 eligibleAsks; // base supply at tick <= clearTick
        uint128 quoteVolume; // quote paid by buyers / received by sellers in total
    }

    struct BatchSummary {
        uint64 batch;
        bool settled;
        uint8 clearTick;
        uint32 orderCount;
        uint128 volume;
        uint128 totalBids;
        uint128 totalAsks;
    }

    struct OrderView {
        uint256 id;
        uint64 batch;
        uint8 tick;
        Side side;
        bool claimed;
        bool settled;
        uint128 amount;
        uint128 filled; // after settlement
        uint256 baseOut; // what claim pays out, after settlement
        uint256 quoteOut;
    }

    mapping(uint64 => Batch) private batches;
    Order[] public orders;
    mapping(address => uint256) public lastOrderOf; // id + 1 of the owner's newest order
    uint64[] public activeBatches; // every block that received at least one order, in order
    uint64[] public settledBatches;
    uint32 public maxBatchOrders; // record: most orders ever received in one block
    uint64 public maxBatchBlock;

    event OrderSubmitted(
        uint256 indexed orderId, uint64 indexed batch, address indexed owner, Side side, uint8 tick, uint128 amount
    );
    event BatchSettled(uint64 indexed batch, uint8 clearTick, uint256 clearPrice, uint128 volume);
    event Claimed(uint256 indexed orderId, address indexed owner, uint128 filled, uint256 baseOut, uint256 quoteOut);

    constructor(IERC20 _base, IERC20 _quote) {
        base = _base;
        quote = _quote;
    }

    // ---------------------------------------------------------------- submit

    function tickPrice(uint8 tick) public pure returns (uint256) {
        return MIN_PRICE + uint256(tick) * TICK_SIZE;
    }

    /// @notice Submit an order into the current block's batch.
    function submitOrder(Side side, uint8 tick, uint128 amount) public returns (uint256 id) {
        require(tick < TICKS, "tick");
        require(amount > 0, "amount");
        uint64 batch = uint64(block.number);
        Batch storage b = batches[batch];
        require(!b.settled, "settled");

        // effects: aggregate into the tick, update batch counters, index the order
        uint256 packed = _bookGet(batch, tick);
        uint128 bid = uint128(packed);
        uint128 ask = uint128(packed >> 128);
        if (side == Side.Buy) {
            bid += amount;
            b.totalBids += amount;
        } else {
            ask += amount;
            b.totalAsks += amount;
        }
        _bookSet(batch, tick, uint256(bid) | (uint256(ask) << 128));

        uint32 count = b.orderCount + 1;
        b.orderCount = count;
        if (count == 1) activeBatches.push(batch);
        if (count > maxBatchOrders) {
            maxBatchOrders = count;
            maxBatchBlock = batch;
        }

        id = orders.length;
        orders.push(Order(msg.sender, batch, tick, side, false, amount, uint64(lastOrderOf[msg.sender])));
        lastOrderOf[msg.sender] = id + 1;
        emit OrderSubmitted(id, batch, msg.sender, side, tick, amount);

        // interactions: escrow the funds
        if (side == Side.Buy) {
            require(quote.transferFrom(msg.sender, address(this), _quoteForUp(amount, tickPrice(tick))), "pay quote");
        } else {
            require(base.transferFrom(msg.sender, address(this), amount), "pay base");
        }
    }

    /// @notice Submit many orders in one transaction (for bots / load tests).
    function submitOrders(Side[] calldata sides, uint8[] calldata ticks, uint128[] calldata amounts) external {
        require(sides.length == ticks.length && ticks.length == amounts.length, "len");
        for (uint256 i; i < sides.length; ++i) {
            submitOrder(sides[i], ticks[i], amounts[i]);
        }
    }

    // ---------------------------------------------------------------- settle

    /// @notice Clear a finished batch at the uniform price that maximizes matched volume
    ///         (ties: lowest price, which protects buyers who set loose limits).
    ///         Callable by anyone; gas is constant (fixed 64-slot scan).
    function settle(uint64 batch) external {
        require(batch < block.number, "open");
        require(!batches[batch].settled, "settled");
        _settle(batch);
    }

    /// @notice Clear several batches in one transaction. Batches that are still open or already cleared are skipped.
    function settleMany(uint64[] calldata list) external {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] < block.number && !batches[list[i]].settled) _settle(list[i]);
        }
    }

    function _settle(uint64 batch) private {
        Batch storage b = batches[batch];
        // demand(i) = bids at tick >= i ; supply(i) = asks at tick <= i
        uint256 demand = b.totalBids;
        uint256 supply;
        uint256 bestVolume;
        uint256 bestTick;
        uint256 bestDemand;
        uint256 bestSupply;
        for (uint256 i; i < TICKS; ++i) {
            uint256 slot = _bookGet(batch, i);
            supply += uint128(slot >> 128);
            uint256 matched = demand < supply ? demand : supply;
            if (matched > bestVolume) {
                bestVolume = matched;
                bestTick = i;
                bestDemand = demand;
                bestSupply = supply;
            }
            demand -= uint128(slot);
        }

        b.settled = true;
        b.clearTick = uint8(bestTick);
        b.volume = uint128(bestVolume);
        b.eligibleBids = uint128(bestDemand);
        b.eligibleAsks = uint128(bestSupply);
        b.quoteVolume = uint128(_quoteFor(bestVolume, tickPrice(uint8(bestTick))));
        settledBatches.push(batch);
        emit BatchSettled(batch, uint8(bestTick), tickPrice(uint8(bestTick)), uint128(bestVolume));
    }

    // ----------------------------------------------------------------- claim

    /// @notice Settle an order: pay out fills and refund unused escrow.
    function claim(uint256 orderId) external {
        Order storage o = orders[orderId];
        require(!o.claimed, "claimed");
        require(batches[o.batch].settled, "unsettled");
        _claim(orderId, o);
    }

    /// @notice Claim many orders in one transaction. Orders that are already claimed or not yet cleared are skipped.
    function claimMany(uint256[] calldata ids) external {
        for (uint256 i; i < ids.length; ++i) {
            Order storage o = orders[ids[i]];
            if (!o.claimed && batches[o.batch].settled) _claim(ids[i], o);
        }
    }

    function _claim(uint256 orderId, Order storage o) private {
        o.claimed = true;
        (uint128 filled, uint256 baseOut, uint256 quoteOut) = _payout(o, batches[o.batch]);
        if (baseOut > 0) require(base.transfer(o.owner, baseOut), "base out");
        if (quoteOut > 0) require(quote.transfer(o.owner, quoteOut), "quote out");
        emit Claimed(orderId, o.owner, filled, baseOut, quoteOut);
    }

    function _payout(Order storage o, Batch storage b)
        private
        view
        returns (uint128 filled, uint256 baseOut, uint256 quoteOut)
    {
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
    }

    // ----------------------------------------------------------------- views

    function ordersLength() external view returns (uint256) {
        return orders.length;
    }

    function activeBatchCount() external view returns (uint256) {
        return activeBatches.length;
    }

    function settledBatchCount() external view returns (uint256) {
        return settledBatches.length;
    }

    /// @notice What `claim` would pay for a settled order (view helper for UIs and demos).
    function previewClaim(uint256 orderId) external view returns (uint128 filled, uint256 baseOut, uint256 quoteOut) {
        Order storage o = orders[orderId];
        require(batches[o.batch].settled, "unsettled");
        return _payout(o, batches[o.batch]);
    }

    /// @notice The full book of a batch, unpacked.
    function getBatch(uint64 batch)
        external
        view
        returns (bool settled, uint8 clearTick, uint128 volume, uint128[TICKS] memory bids, uint128[TICKS] memory asks)
    {
        Batch storage b = batches[batch];
        for (uint256 i; i < TICKS; ++i) {
            uint256 slot = _bookGet(batch, i);
            bids[i] = uint128(slot);
            asks[i] = uint128(slot >> 128);
        }
        return (b.settled, b.clearTick, b.volume, bids, asks);
    }

    /// @notice The newest `count` batches that received orders, newest first.
    function recentBatches(uint256 count) external view returns (BatchSummary[] memory out) {
        uint256 total = activeBatches.length;
        uint256 n = count < total ? count : total;
        out = new BatchSummary[](n);
        for (uint256 i; i < n; ++i) {
            uint64 batch = activeBatches[total - 1 - i];
            Batch storage b = batches[batch];
            out[i] = BatchSummary(batch, b.settled, b.clearTick, b.orderCount, b.volume, b.totalBids, b.totalAsks);
        }
    }

    /// @notice An account's newest `limit` orders, newest first, with settlement results.
    function ordersOf(address owner, uint256 limit) external view returns (OrderView[] memory out) {
        out = new OrderView[](limit);
        uint256 cursor = lastOrderOf[owner];
        uint256 n;
        while (cursor != 0 && n < limit) {
            uint256 id = cursor - 1;
            Order storage o = orders[id];
            Batch storage b = batches[o.batch];
            OrderView memory v = OrderView(id, o.batch, o.tick, o.side, o.claimed, b.settled, o.amount, 0, 0, 0);
            if (b.settled) (v.filled, v.baseOut, v.quoteOut) = _payout(o, b);
            out[n++] = v;
            cursor = o.prevByOwner;
        }
        assembly {
            mstore(out, n) // trim to the number of orders found
        }
    }

    // ---------------------------------------------------------------- helpers

    /// @dev First slot of a batch's book: keccak of the batch number rounded down to a multiple of 128,
    ///      so the 64 tick slots never straddle a 128-slot page boundary.
    function _bookBase(uint64 batch) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(batch, "pulse.book"))) & ~uint256(127);
    }

    function _bookGet(uint64 batch, uint256 tick) private view returns (uint256 v) {
        uint256 slot = _bookBase(batch) + tick;
        assembly {
            v := sload(slot)
        }
    }

    function _bookSet(uint64 batch, uint256 tick, uint256 v) private {
        uint256 slot = _bookBase(batch) + tick;
        assembly {
            sstore(slot, v)
        }
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
