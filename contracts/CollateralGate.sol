// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Form, Status, Row, IStateraFeed} from "./IStateraFeed.sol";

/**
 * @title CollateralGate
 * @notice An example lender that values tokenized-stock collateral at what it could
 *         actually be sold for, and refuses it outright when it could not be.
 *
 * This is the point statera exists to make. A lender that marks collateral at an
 * oracle price is solvent only on paper: the oracle says a position is worth
 * $100,000, and liquidation discovers the pools return $60,000. So this contract
 * never reads the mark. It reads the realisable value — proceeds of actually selling
 * that size into live X Layer liquidity — and it treats the three failure modes as
 * refusals rather than as zeros:
 *
 *   Unmeasured  the engine could not measure. Not "worth nothing"; worth UNKNOWN,
 *               which is not something to lend against.
 *   Absent      the pools cannot absorb that size at all. The revert carries how
 *               much they could, so a caller can retry smaller instead of guessing.
 *   Stale       the numbers were true once. Depth moves; an old depth reading is not
 *               evidence about now.
 *
 * TIER SELECTION. The feed measures discrete sizes. A borrower pledging $40,000 is
 * quoted against the smallest tier at or above that — the $100,000 row, not the
 * $10,000 one — because the cost of selling $40,000 is bounded by the cost of
 * selling $100,000 and never by the cost of selling $10,000. Rounding down to the
 * nearest measured tier would flatter the borrower with a slippage figure from a
 * trade a tenth the size. Rounding up is the conservative direction, and when no
 * tier is large enough the contract refuses rather than extrapolate.
 */
contract CollateralGate {
    /// @notice The feed being read. Immutable: a lender's valuation source should not
    ///         be repointable by whoever holds an admin key.
    IStateraFeed public immutable feed;

    /// @notice How old a row may be and still be lent against.
    uint256 public immutable maxAgeSeconds;

    uint256 private constant USD_SCALE = 1e6;
    uint256 private constant BPS = 10_000;

    /* --------------------------------------------------------------- errors */

    /// @notice The feed has never published any tier for this asset and form.
    error UnknownSeries(address token, Form form);
    /// @notice Every measured tier is smaller than the amount pledged.
    error NoTierCoversAmount(address token, Form form, uint256 amountUsd, uint32 largestTierUsd);
    /// @notice The covering tier was never measured, so its value is unknown.
    error RowUnmeasured(address token, Form form, uint32 tierUsd);
    /// @notice The pools cannot fill that size. `fillableUsd` is what they could.
    error CollateralNotSellableAtSize(address token, Form form, uint32 tierUsd, uint128 fillableUsd);
    /// @notice The row is too old to be evidence about present depth.
    error RowStale(address token, Form form, uint32 tierUsd, uint48 publishedAt, uint256 ageSeconds, uint256 maxAge);
    error ZeroAmount();
    error InvalidLtv(uint16 ltvBps);

    /* ---------------------------------------------------------------- types */

    /// @notice Why a valuation was refused, for callers that prefer a flag to a revert.
    enum Refusal {
        None,
        UnknownSeries,
        NoTierCoversAmount,
        Unmeasured,
        NotSellable,
        Stale
    }

    constructor(IStateraFeed feed_, uint256 maxAgeSeconds_) {
        feed = feed_;
        maxAgeSeconds = maxAgeSeconds_;
    }

    /* ----------------------------------------------------------------- core */

    /**
     * @notice What may be borrowed against `amountUsd` of this collateral.
     * @param token The raw xStock address identifying the asset.
     * @param form Raw or Wrapped — they are not interchangeable; only one of them
     *        can be sold without an extra wrap transaction.
     * @param amountUsd Face value pledged, USD with 6 decimals.
     * @param ltvBps Loan-to-value in basis points, applied to the REALISABLE value.
     * @return limitUsd Borrow limit, USD with 6 decimals.
     */
    function borrowLimitUsd(address token, Form form, uint256 amountUsd, uint16 ltvBps)
        public
        view
        returns (uint256 limitUsd)
    {
        if (ltvBps == 0 || ltvBps > BPS) revert InvalidLtv(ltvBps);
        if (amountUsd == 0) revert ZeroAmount();
        (Row memory row, uint32 tier) = _validated(token, form, amountUsd);
        // One division, not two: dividing out the tier first and then applying the
        // LTV truncates twice and loses precision for no reason.
        uint256 face = uint256(tier) * USD_SCALE;
        return (amountUsd * uint256(row.realisableUsd) * uint256(ltvBps)) / (face * BPS);
    }

    /**
     * @notice The collateral's realisable value, before any LTV haircut.
     * @dev Scales the covering tier's realisable rate down to the pledged amount.
     *      That rate came from a larger sale, so applying it to a smaller one is
     *      conservative — which is the direction a lender should err in.
     */
    function realisableValueUsd(address token, Form form, uint256 amountUsd) public view returns (uint256) {
        if (amountUsd == 0) revert ZeroAmount();
        (Row memory row, uint32 tier) = _validated(token, form, amountUsd);
        uint256 face = uint256(tier) * USD_SCALE;
        return (amountUsd * uint256(row.realisableUsd)) / face;
    }

    /**
     * @notice The haircut the feed implies for this size, in basis points.
     * @dev Positive means the pools pay less than face. Useful for display; the
     *      lending decision uses realisableValueUsd directly.
     */
    function haircutBps(address token, Form form, uint256 amountUsd) external view returns (uint256) {
        uint256 value = realisableValueUsd(token, form, amountUsd);
        if (value >= amountUsd) return 0;
        return ((amountUsd - value) * BPS) / amountUsd;
    }

    /**
     * @notice Non-reverting form, for UIs that want to show the reason.
     * @return refusal Why it was refused, or Refusal.None.
     * @return limitUsd The limit when refusal is None, else 0.
     * @return tierUsd The tier consulted, or 0 when none was.
     * @return fillableUsd What the pools could fill when the refusal is NotSellable.
     */
    function tryBorrowLimitUsd(address token, Form form, uint256 amountUsd, uint16 ltvBps)
        external
        view
        returns (Refusal refusal, uint256 limitUsd, uint32 tierUsd, uint128 fillableUsd)
    {
        if (amountUsd == 0 || ltvBps == 0 || ltvBps > BPS) return (Refusal.NoTierCoversAmount, 0, 0, 0);

        uint32[] memory ts = feed.tiers(token, form);
        if (ts.length == 0) return (Refusal.UnknownSeries, 0, 0, 0);

        (uint32 tier, bool found) = _smallestCovering(ts, amountUsd);
        if (!found) return (Refusal.NoTierCoversAmount, 0, 0, 0);

        Row memory row = feed.latestFor(token, form, tier);
        if (row.status == uint8(Status.Unmeasured)) return (Refusal.Unmeasured, 0, tier, 0);
        if (row.status == uint8(Status.Absent)) return (Refusal.NotSellable, 0, tier, row.fillableUsd);
        if (block.timestamp - uint256(row.publishedAt) > maxAgeSeconds) return (Refusal.Stale, 0, tier, 0);

        uint256 face = uint256(tier) * USD_SCALE;
        uint256 value = (amountUsd * uint256(row.realisableUsd)) / face;
        return (Refusal.None, (value * uint256(ltvBps)) / BPS, tier, 0);
    }

    /* ------------------------------------------------------------- internals */

    /// @dev Resolve the covering tier and return its row, having refused every
    ///      condition a lender must refuse. All the reverts live here so the two
    ///      public entry points cannot drift apart on what they accept.
    function _validated(address token, Form form, uint256 amountUsd)
        private
        view
        returns (Row memory row, uint32 tier)
    {
        tier = _coveringTier(token, form, amountUsd);
        row = feed.latestFor(token, form, tier);

        if (row.status == uint8(Status.Unmeasured)) revert RowUnmeasured(token, form, tier);
        if (row.status == uint8(Status.Absent)) {
            revert CollateralNotSellableAtSize(token, form, tier, row.fillableUsd);
        }
        // publishedAt cannot be zero here: an unposted row reads back as Unmeasured.
        uint256 age = block.timestamp - uint256(row.publishedAt);
        if (age > maxAgeSeconds) {
            revert RowStale(token, form, tier, row.publishedAt, age, maxAgeSeconds);
        }
    }


    /// @notice The tier that would be consulted for this amount.
    function coveringTierUsd(address token, Form form, uint256 amountUsd) external view returns (uint32) {
        return _coveringTier(token, form, amountUsd);
    }

    function _coveringTier(address token, Form form, uint256 amountUsd) private view returns (uint32) {
        uint32[] memory ts = feed.tiers(token, form);
        if (ts.length == 0) revert UnknownSeries(token, form);
        (uint32 tier, bool found) = _smallestCovering(ts, amountUsd);
        if (!found) {
            uint32 largest = 0;
            for (uint256 i = 0; i < ts.length; ++i) {
                if (ts[i] > largest) largest = ts[i];
            }
            revert NoTierCoversAmount(token, form, amountUsd, largest);
        }
        return tier;
    }

    /// @dev Smallest tier whose face value is >= amountUsd. The feed does not keep
    ///      tiers sorted, so this scans; the list is a handful of entries.
    function _smallestCovering(uint32[] memory ts, uint256 amountUsd) private pure returns (uint32, bool) {
        uint32 best = 0;
        bool found = false;
        for (uint256 i = 0; i < ts.length; ++i) {
            uint256 face = uint256(ts[i]) * USD_SCALE;
            if (face < amountUsd) continue;
            if (!found || ts[i] < best) {
                best = ts[i];
                found = true;
            }
        }
        return (best, found);
    }
}
