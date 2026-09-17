// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StateraFeed} from "../StateraFeed.sol";
import {CollateralGate} from "../CollateralGate.sol";
import {Form, Status, Row, RowInput, IStateraFeed} from "../IStateraFeed.sol";

contract CollateralGateTest is Test {
    StateraFeed feed;
    CollateralGate gate;

    address publisher = address(0xBEEF);
    address NVDAx = 0xc845b2894dBddd03858fd2D643B4eF725fE0849d;
    address TSLAx = 0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0;
    address SPYx = 0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48;

    uint40 constant ENGINE_BLOCK = 70_885_401;
    uint256 constant MAX_AGE = 1800; // 30 minutes, matching the keeper's heartbeat
    uint16 constant LTV = 5000; // 50%

    // Live-shaped numbers from the phase 1 engine at block 70,885,401.
    uint128 constant NVDA_MARK = 220_018_700; // $220.0187 per wNVDAx
    uint128 constant NVDA_R_1K = 997_600_000; // $997.60 for a $1,000 sale
    uint128 constant NVDA_R_10K = 9_959_110_000; // $9,959.11
    uint128 constant NVDA_R_100K = 97_924_170_000; // $97,924.17

    function setUp() public {
        feed = new StateraFeed(publisher);
        gate = new CollateralGate(IStateraFeed(address(feed)), MAX_AGE);
        vm.warp(1_750_000_000);
    }

    /* ------------------------------------------------------------- helpers */

    function gapOf(uint32 tier, uint128 realisable) internal pure returns (int256) {
        int256 face = int256(uint256(tier) * 1e6);
        return ((int256(uint256(realisable)) - face) * 10_000) / face;
    }

    function measured(address token, Form form, uint32 tier, uint128 mark, uint128 realisable)
        internal
        pure
        returns (RowInput memory)
    {
        return RowInput({
            token: token,
            form: form,
            sizeTierUsd: tier,
            markUsd: mark,
            realisableUsd: realisable,
            fillableUsd: 0,
            gapBps: int32(gapOf(tier, realisable)),
            status: Status.Measured
        });
    }

    function absent(address token, Form form, uint32 tier, uint128 mark, uint128 realisable, uint128 fillable)
        internal
        pure
        returns (RowInput memory)
    {
        return RowInput({
            token: token,
            form: form,
            sizeTierUsd: tier,
            markUsd: mark,
            realisableUsd: realisable,
            fillableUsd: fillable,
            gapBps: 0,
            status: Status.Absent
        });
    }

    function unmeasured(address token, Form form, uint32 tier) internal pure returns (RowInput memory) {
        return RowInput({
            token: token,
            form: form,
            sizeTierUsd: tier,
            markUsd: 0,
            realisableUsd: 0,
            fillableUsd: 0,
            gapBps: 0,
            status: Status.Unmeasured
        });
    }

    /// @dev The standard three-tier wNVDAx series.
    function postNvdaSeries() internal {
        RowInput[] memory rows = new RowInput[](3);
        rows[0] = measured(NVDAx, Form.Wrapped, 1000, NVDA_MARK, NVDA_R_1K);
        rows[1] = measured(NVDAx, Form.Wrapped, 10000, NVDA_MARK, NVDA_R_10K);
        rows[2] = measured(NVDAx, Form.Wrapped, 100000, NVDA_MARK, NVDA_R_100K);
        vm.prank(publisher);
        feed.post(ENGINE_BLOCK, rows);
    }

    function postOne(RowInput memory r) internal {
        RowInput[] memory rows = new RowInput[](1);
        rows[0] = r;
        vm.prank(publisher);
        feed.post(ENGINE_BLOCK, rows);
    }

    /* ------------------------------------------------------------ wiring */

    function test_constructor_wiresFeedAndAge() public view {
        assertEq(address(gate.feed()), address(feed));
        assertEq(gate.maxAgeSeconds(), MAX_AGE);
    }

    /* --------------------------------------- the whole point: not the mark */

    /**
     * @notice The headline behaviour. A $100,000 pledge is valued at what the pools
     *         would actually pay, not at 100,000 of oracle dollars.
     */
    function test_valuesCollateralAtRealisable_notAtMark() public {
        postNvdaSeries();
        uint256 pledged = 100_000 * 1e6;

        uint256 value = gate.realisableValueUsd(NVDAx, Form.Wrapped, pledged);
        assertEq(value, NVDA_R_100K, "must equal the realisable value for the tier");
        assertLt(value, pledged, "realisable must be below face");

        uint256 limit = gate.borrowLimitUsd(NVDAx, Form.Wrapped, pledged, LTV);
        assertEq(limit, (uint256(NVDA_R_100K) * LTV) / 10_000);

        // A mark-based lender would have extended more. That difference is the risk
        // statera exists to price.
        uint256 markBasedLimit = (pledged * LTV) / 10_000;
        assertLt(limit, markBasedLimit);
        assertEq(markBasedLimit - limit, 1_037_915_000); // $1,037.92 of phantom credit
    }

    function test_haircutBps_matchesTheFeedsGap() public {
        postNvdaSeries();
        uint256 pledged = 100_000 * 1e6;
        // The gap the feed stored, and the haircut the gate derives, agree.
        int32 gap = feed.latestFor(NVDAx, Form.Wrapped, 100000).gapBps;
        assertEq(gap, -207);
        assertEq(gate.haircutBps(NVDAx, Form.Wrapped, pledged), 207);
    }

    function test_ltvIsAppliedToRealisable() public {
        postNvdaSeries();
        uint256 pledged = 100_000 * 1e6;
        assertEq(gate.borrowLimitUsd(NVDAx, Form.Wrapped, pledged, 10_000), NVDA_R_100K);
        assertEq(gate.borrowLimitUsd(NVDAx, Form.Wrapped, pledged, 5_000), NVDA_R_100K / 2);
        assertEq(gate.borrowLimitUsd(NVDAx, Form.Wrapped, pledged, 1), uint256(NVDA_R_100K) / 10_000);
    }

    /* ------------------------------------------------------ tier selection */

    function test_tierSelection_exactMatch() public {
        postNvdaSeries();
        assertEq(gate.coveringTierUsd(NVDAx, Form.Wrapped, 10_000 * 1e6), 10000);
    }

    /// @notice A $40,000 pledge must be priced off the $100,000 row, never the $10,000.
    function test_tierSelection_roundsUpToTheCoveringTier() public {
        postNvdaSeries();
        assertEq(gate.coveringTierUsd(NVDAx, Form.Wrapped, 40_000 * 1e6), 100000);

        uint256 value = gate.realisableValueUsd(NVDAx, Form.Wrapped, 40_000 * 1e6);
        // 40,000 valued at the 100k tier's rate, i.e. 40% of 97,924.17.
        assertEq(value, (uint256(40_000 * 1e6) * NVDA_R_100K) / (100_000 * 1e6));

        // Had it rounded DOWN to the 10k tier it would have looked better than this.
        uint256 flattering = (uint256(40_000 * 1e6) * NVDA_R_10K) / (10_000 * 1e6);
        assertGt(flattering, value, "rounding down would overvalue the collateral");
    }

    function test_tierSelection_oneWeiOverATierMovesUp() public {
        postNvdaSeries();
        assertEq(gate.coveringTierUsd(NVDAx, Form.Wrapped, 1000 * 1e6), 1000);
        assertEq(gate.coveringTierUsd(NVDAx, Form.Wrapped, 1000 * 1e6 + 1), 10000);
    }

    function test_tierSelection_smallestAmountUsesSmallestTier() public {
        postNvdaSeries();
        assertEq(gate.coveringTierUsd(NVDAx, Form.Wrapped, 1), 1000);
    }

    /// @dev The feed stores tiers in first-seen order, not sorted. Selection must
    ///      not depend on the order they happened to arrive in.
    function test_tierSelection_worksWhenTiersArrivedOutOfOrder() public {
        RowInput[] memory rows = new RowInput[](3);
        rows[0] = measured(SPYx, Form.Wrapped, 100000, 766_107_900, 99_295_690_000);
        rows[1] = measured(SPYx, Form.Wrapped, 1000, 766_107_900, 999_080_000);
        rows[2] = measured(SPYx, Form.Wrapped, 10000, 766_107_900, 9_985_230_000);
        vm.prank(publisher);
        feed.post(ENGINE_BLOCK, rows);

        uint32[] memory ts = feed.tiers(SPYx, Form.Wrapped);
        assertEq(ts[0], 100000); // arrival order really is unsorted
        assertEq(gate.coveringTierUsd(SPYx, Form.Wrapped, 5_000 * 1e6), 10000);
        assertEq(gate.coveringTierUsd(SPYx, Form.Wrapped, 500 * 1e6), 1000);
        assertEq(gate.coveringTierUsd(SPYx, Form.Wrapped, 50_000 * 1e6), 100000);
    }

    /* ---------------------------------------------------------- refusals */

    function test_refuses_unknownSeries() public {
        // Nothing has ever been posted for TSLAx.
        vm.expectRevert(abi.encodeWithSelector(CollateralGate.UnknownSeries.selector, TSLAx, Form.Wrapped));
        gate.borrowLimitUsd(TSLAx, Form.Wrapped, 1_000 * 1e6, LTV);
    }

    function test_refuses_wrongFormIsADifferentSeries() public {
        postNvdaSeries(); // Wrapped only
        vm.expectRevert(abi.encodeWithSelector(CollateralGate.UnknownSeries.selector, NVDAx, Form.Raw));
        gate.borrowLimitUsd(NVDAx, Form.Raw, 1_000 * 1e6, LTV);
    }

    function test_refuses_whenNoTierCoversTheAmount() public {
        postNvdaSeries();
        uint256 pledged = 250_000 * 1e6;
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralGate.NoTierCoversAmount.selector, NVDAx, Form.Wrapped, pledged, uint32(100000)
            )
        );
        gate.borrowLimitUsd(NVDAx, Form.Wrapped, pledged, LTV);
    }

    function test_refuses_unmeasuredRow() public {
        postOne(unmeasured(NVDAx, Form.Wrapped, 1000));
        vm.expectRevert(
            abi.encodeWithSelector(CollateralGate.RowUnmeasured.selector, NVDAx, Form.Wrapped, uint32(1000))
        );
        gate.borrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, LTV);
    }

    /// @notice The demo: the pools cannot absorb this size, so the loan is refused
    ///         and the revert says how much they could take.
    function test_refuses_absentRow_andSaysWhatWouldFill() public {
        postOne(absent(NVDAx, Form.Wrapped, 500000, 219_708_100, 293_456_510_000, 372_798_000_000));
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralGate.CollateralNotSellableAtSize.selector,
                NVDAx,
                Form.Wrapped,
                uint32(500000),
                uint128(372_798_000_000)
            )
        );
        gate.borrowLimitUsd(NVDAx, Form.Wrapped, 400_000 * 1e6, LTV);
    }

    function test_refuses_staleRow() public {
        postNvdaSeries();
        uint48 postedAt = uint48(block.timestamp);
        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralGate.RowStale.selector,
                NVDAx,
                Form.Wrapped,
                uint32(1000),
                postedAt,
                MAX_AGE + 1,
                MAX_AGE
            )
        );
        gate.borrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, LTV);
    }

    function test_acceptsRowExactlyAtTheAgeLimit() public {
        postNvdaSeries();
        vm.warp(block.timestamp + MAX_AGE);
        assertGt(gate.borrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, LTV), 0);
    }

    function test_refuses_zeroAmount() public {
        postNvdaSeries();
        vm.expectRevert(CollateralGate.ZeroAmount.selector);
        gate.borrowLimitUsd(NVDAx, Form.Wrapped, 0, LTV);
        vm.expectRevert(CollateralGate.ZeroAmount.selector);
        gate.realisableValueUsd(NVDAx, Form.Wrapped, 0);
    }

    function test_refuses_invalidLtv() public {
        postNvdaSeries();
        vm.expectRevert(abi.encodeWithSelector(CollateralGate.InvalidLtv.selector, uint16(0)));
        gate.borrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, 0);
        vm.expectRevert(abi.encodeWithSelector(CollateralGate.InvalidLtv.selector, uint16(10_001)));
        gate.borrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, 10_001);
    }

    /// @dev A refusal must not be reachable by passing a huge LTV either.
    function test_refuses_ltvAboveOneHundredPercent() public {
        postNvdaSeries();
        vm.expectRevert(abi.encodeWithSelector(CollateralGate.InvalidLtv.selector, type(uint16).max));
        gate.borrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, type(uint16).max);
    }

    /* ------------------------------------------------- non-reverting form */

    function test_try_returnsNoneAndTheLimitWhenHealthy() public {
        postNvdaSeries();
        (CollateralGate.Refusal refusal, uint256 limit, uint32 tier, uint128 fillable) =
            gate.tryBorrowLimitUsd(NVDAx, Form.Wrapped, 100_000 * 1e6, LTV);
        assertEq(uint8(refusal), uint8(CollateralGate.Refusal.None));
        assertEq(limit, (uint256(NVDA_R_100K) * LTV) / 10_000);
        assertEq(tier, 100000);
        assertEq(fillable, 0);
    }

    function test_try_reportsUnknownSeries() public view {
        (CollateralGate.Refusal refusal,,,) = gate.tryBorrowLimitUsd(TSLAx, Form.Wrapped, 1_000 * 1e6, LTV);
        assertEq(uint8(refusal), uint8(CollateralGate.Refusal.UnknownSeries));
    }

    function test_try_reportsNoTierCovers() public {
        postNvdaSeries();
        (CollateralGate.Refusal refusal,,,) = gate.tryBorrowLimitUsd(NVDAx, Form.Wrapped, 999_000 * 1e6, LTV);
        assertEq(uint8(refusal), uint8(CollateralGate.Refusal.NoTierCoversAmount));
    }

    function test_try_reportsUnmeasured() public {
        postOne(unmeasured(NVDAx, Form.Wrapped, 1000));
        (CollateralGate.Refusal refusal,, uint32 tier,) =
            gate.tryBorrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, LTV);
        assertEq(uint8(refusal), uint8(CollateralGate.Refusal.Unmeasured));
        assertEq(tier, 1000);
    }

    function test_try_reportsNotSellableWithFillable() public {
        postOne(absent(NVDAx, Form.Wrapped, 500000, 219_708_100, 293_456_510_000, 372_798_000_000));
        (CollateralGate.Refusal refusal,, uint32 tier, uint128 fillable) =
            gate.tryBorrowLimitUsd(NVDAx, Form.Wrapped, 400_000 * 1e6, LTV);
        assertEq(uint8(refusal), uint8(CollateralGate.Refusal.NotSellable));
        assertEq(tier, 500000);
        assertEq(fillable, 372_798_000_000);
    }

    function test_try_reportsStale() public {
        postNvdaSeries();
        vm.warp(block.timestamp + MAX_AGE + 1);
        (CollateralGate.Refusal refusal,, uint32 tier,) =
            gate.tryBorrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, LTV);
        assertEq(uint8(refusal), uint8(CollateralGate.Refusal.Stale));
        assertEq(tier, 1000);
    }

    function test_try_neverRevertsWhereTheStrictFormDoes() public {
        // Same inputs that revert above return a flag here, which is the contract.
        gate.tryBorrowLimitUsd(TSLAx, Form.Wrapped, 1_000 * 1e6, LTV);
        gate.tryBorrowLimitUsd(NVDAx, Form.Wrapped, 0, LTV);
        gate.tryBorrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, 0);
    }

    /* ------------------------------------------------------- recovery path */

    function test_aRefusedRowBecomesUsableAfterAFreshPost() public {
        postOne(unmeasured(NVDAx, Form.Wrapped, 1000));
        vm.expectRevert(
            abi.encodeWithSelector(CollateralGate.RowUnmeasured.selector, NVDAx, Form.Wrapped, uint32(1000))
        );
        gate.borrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, LTV);

        postOne(measured(NVDAx, Form.Wrapped, 1000, NVDA_MARK, NVDA_R_1K));
        assertEq(gate.borrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, LTV), (uint256(NVDA_R_1K) * LTV) / 10_000);
    }

    /* ----------------------------------------------------------------- fuzz */

    function testFuzz_limitNeverExceedsFaceValueTimesLtv(uint256 amountUsd) public {
        postNvdaSeries();
        amountUsd = bound(amountUsd, 1, 100_000 * 1e6);
        uint256 limit = gate.borrowLimitUsd(NVDAx, Form.Wrapped, amountUsd, LTV);
        // Realisable is below face for every tier here, so the limit must be too.
        assertLe(limit, (amountUsd * LTV) / 10_000);
    }

    function testFuzz_valuationIsMonotonicInAmount(uint256 a, uint256 b) public {
        postNvdaSeries();
        a = bound(a, 1, 100_000 * 1e6);
        b = bound(b, 1, 100_000 * 1e6);
        if (a > b) (a, b) = (b, a);
        // Larger pledges can only be valued at the same or a worse rate, never better.
        uint256 va = gate.realisableValueUsd(NVDAx, Form.Wrapped, a);
        uint256 vb = gate.realisableValueUsd(NVDAx, Form.Wrapped, b);
        assertLe(va, vb + 1);
    }
}
