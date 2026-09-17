// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StateraFeed} from "../StateraFeed.sol";
import {Form, Status, Row, RowInput} from "../IStateraFeed.sol";

contract StateraFeedTest is Test {
    StateraFeed feed;

    address publisher = address(0xBEEF);
    address stranger = address(0xDEAD);
    address NVDAx = 0xc845b2894dBddd03858fd2D643B4eF725fE0849d;
    address TSLAx = 0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0;

    uint40 constant ENGINE_BLOCK = 70_885_401;

    function setUp() public {
        feed = new StateraFeed(publisher);
        // A sane wall clock; the default of 1 makes freshness arithmetic awkward.
        vm.warp(1_750_000_000);
    }

    /* ------------------------------------------------------------- helpers */

    /// @dev The gap the feed will expect. Computed locally on purpose: a helper that
    ///      called feed.expectedGapBps would consume any pending vm.prank, which
    ///      silently turned one publisher-check test into a false pass.
    function gapOf(uint32 tier, uint128 realisable) internal pure returns (int256) {
        int256 face = int256(uint256(tier) * 1e6);
        return ((int256(uint256(realisable)) - face) * 10_000) / face;
    }

    /// @dev A Measured row whose gap is, by construction, the honest one.
    function measured(address token, Form form, uint32 tier, uint128 mark, uint128 realisable)
        internal
        pure
        returns (RowInput memory)
    {
        int256 gap = gapOf(tier, realisable);
        return RowInput({
            token: token,
            form: form,
            sizeTierUsd: tier,
            markUsd: mark,
            realisableUsd: realisable,
            fillableUsd: 0,
            gapBps: int32(gap),
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

    function one(RowInput memory r) internal pure returns (RowInput[] memory rows) {
        rows = new RowInput[](1);
        rows[0] = r;
    }

    function postOne(RowInput memory r) internal {
        vm.prank(publisher);
        feed.post(ENGINE_BLOCK, one(r));
    }

    /* --------------------------------------------------------- constructor */

    function test_constructor_setsImmutablePublisher() public view {
        assertEq(feed.publisher(), publisher);
    }

    function test_constructor_rejectsZeroPublisher() public {
        vm.expectRevert(StateraFeed.ZeroToken.selector);
        new StateraFeed(address(0));
    }

    function test_noPublisherTransferExists() public view {
        // The publisher is immutable by design; assert the getter is the only surface.
        assertEq(feed.publisher(), publisher);
        assertEq(feed.runCount(), 0);
    }

    /* ------------------------------------------------------ publisher check */

    function test_post_revertsForNonPublisher() public {
        RowInput[] memory rows = one(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.NotPublisher.selector, stranger));
        feed.post(ENGINE_BLOCK, rows);
    }

    function test_post_revertsForDeployerWhoIsNotPublisher() public {
        RowInput[] memory rows = one(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        // `this` deployed the feed but was never the publisher.
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.NotPublisher.selector, address(this)));
        feed.post(ENGINE_BLOCK, rows);
    }

    /* ------------------------------------------------------- run-level rules */

    function test_post_revertsOnEmptyRun() public {
        RowInput[] memory rows = new RowInput[](0);
        vm.prank(publisher);
        vm.expectRevert(StateraFeed.NoRows.selector);
        feed.post(ENGINE_BLOCK, rows);
    }

    function test_post_revertsOnZeroEngineBlock() public {
        RowInput[] memory rows = one(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        vm.prank(publisher);
        vm.expectRevert(StateraFeed.ZeroEngineBlock.selector);
        feed.post(0, rows);
    }

    function test_post_revertsOnZeroToken() public {
        RowInput[] memory rows = one(measured(address(0), Form.Wrapped, 1000, 1, 997_600_000));
        vm.prank(publisher);
        vm.expectRevert(StateraFeed.ZeroToken.selector);
        feed.post(ENGINE_BLOCK, rows);
    }

    function test_post_revertsOnZeroTier() public {
        RowInput memory r = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000);
        r.sizeTierUsd = 0;
        vm.prank(publisher);
        vm.expectRevert(StateraFeed.ZeroTier.selector);
        feed.post(ENGINE_BLOCK, one(r));
    }

    function test_post_engineBlockCannotGoBackwards() public {
        postOne(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        RowInput[] memory rows = one(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(StateraFeed.EngineBlockWentBackwards.selector, ENGINE_BLOCK - 1, ENGINE_BLOCK)
        );
        feed.post(ENGINE_BLOCK - 1, rows);
    }

    function test_post_sameEngineBlockIsAllowed() public {
        postOne(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        postOne(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        assertEq(feed.runCount(), 2);
    }

    function test_runCountAndRunMetadataAdvance() public {
        postOne(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        assertEq(feed.runCount(), 1);
        assertEq(feed.lastEngineBlock(), ENGINE_BLOCK);
        assertEq(feed.lastPublishedAt(), uint48(block.timestamp));
    }

    /* ------------------------------------------------------- measured rules */

    function test_measured_storesEveryField() public {
        RowInput memory r = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000);
        postOne(r);

        Row memory got = feed.latestFor(NVDAx, Form.Wrapped, 1000);
        assertEq(got.markUsd, 220_018_700);
        assertEq(got.realisableUsd, 997_600_000);
        assertEq(got.fillableUsd, 0);
        assertEq(got.gapBps, -24); // (997.60 - 1000) / 1000 = -24 bps
        assertEq(got.status, uint8(Status.Measured));
        assertEq(got.engineBlock, ENGINE_BLOCK);
        assertEq(got.publishedAt, uint48(block.timestamp));
    }

    function test_measured_emitsOneEventPerRow() public {
        RowInput[] memory rows = new RowInput[](2);
        rows[0] = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000);
        rows[1] = measured(TSLAx, Form.Raw, 10000, 373_920_000, 9_917_320_000);

        vm.prank(publisher);
        vm.recordLogs();
        feed.post(ENGINE_BLOCK, rows);
        // Two RowPosted plus one RunPosted.
        assertEq(vm.getRecordedLogs().length, 3);
    }

    function test_measured_revertsWhenMarkMissing() public {
        RowInput memory r = measured(NVDAx, Form.Wrapped, 1000, 0, 997_600_000);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.MeasuredRowIncomplete.selector, 0));
        feed.post(ENGINE_BLOCK, one(r));
    }

    function test_measured_revertsWhenRealisableMissing() public {
        RowInput memory r = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 1);
        r.realisableUsd = 0;
        r.gapBps = 0;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.MeasuredRowIncomplete.selector, 0));
        feed.post(ENGINE_BLOCK, one(r));
    }

    /// @notice The gap cannot be misstated independently of the values it summarises.
    function test_measured_revertsOnFlatteringGap() public {
        RowInput memory r = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000);
        r.gapBps = -1; // claim a 1 bp cost where the values imply 24
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.GapInconsistent.selector, 0, int32(-1), int256(-24)));
        feed.post(ENGINE_BLOCK, one(r));
    }

    function test_measured_revertsOnPositiveGapWhenValuesSayNegative() public {
        RowInput memory r = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000);
        r.gapBps = 500;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.GapInconsistent.selector, 0, int32(500), int256(-24)));
        feed.post(ENGINE_BLOCK, one(r));
    }

    function test_measured_acceptsGapOffByOneBp() public {
        // Rounding slack, both directions.
        RowInput memory up = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000);
        up.gapBps = -23;
        postOne(up);
        assertEq(feed.latestFor(NVDAx, Form.Wrapped, 1000).gapBps, -23);

        RowInput memory down = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000);
        down.gapBps = -25;
        postOne(down);
        assertEq(feed.latestFor(NVDAx, Form.Wrapped, 1000).gapBps, -25);
    }

    function test_measured_rejectsGapOffByTwoBps() public {
        RowInput memory r = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000);
        r.gapBps = -22;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.GapInconsistent.selector, 0, int32(-22), int256(-24)));
        feed.post(ENGINE_BLOCK, one(r));
    }

    function test_measured_allowsGenuinelyZeroGap() public {
        // A row that realises exactly face value is legal and must not be mistaken
        // for a row that forgot to carry a gap.
        RowInput memory r = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 1_000_000_000);
        assertEq(r.gapBps, 0);
        postOne(r);
        Row memory got = feed.latestFor(NVDAx, Form.Wrapped, 1000);
        assertEq(got.status, uint8(Status.Measured));
        assertEq(got.gapBps, 0);
    }

    function test_measured_allowsPositiveGap() public {
        // The pools can pay above the mark; venue basis is real.
        RowInput memory r = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 1_000_060_000);
        assertEq(r.gapBps, 0); // 0.6 bp truncates to 0
        postOne(r);
        assertEq(feed.latestFor(NVDAx, Form.Wrapped, 1000).realisableUsd, 1_000_060_000);
    }

    /* --------------------------------------------------------- absent rules */

    function test_absent_storesFillable() public {
        postOne(absent(NVDAx, Form.Wrapped, 500000, 219_708_100, 293_456_510_000, 372_798_000_000));
        Row memory got = feed.latestFor(NVDAx, Form.Wrapped, 500000);
        assertEq(got.status, uint8(Status.Absent));
        assertEq(got.fillableUsd, 372_798_000_000);
        assertEq(got.gapBps, 0);
    }

    function test_absent_revertsWithoutFillable() public {
        RowInput memory r = absent(NVDAx, Form.Wrapped, 500000, 219_708_100, 293_456_510_000, 0);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.AbsentRowNeedsFillable.selector, 0));
        feed.post(ENGINE_BLOCK, one(r));
    }

    function test_absent_revertsWhenItClaimsAGap() public {
        RowInput memory r = absent(NVDAx, Form.Wrapped, 500000, 219_708_100, 293_456_510_000, 372_798_000_000);
        r.gapBps = -4131;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.NonMeasuredRowHasGap.selector, 0, int32(-4131)));
        feed.post(ENGINE_BLOCK, one(r));
    }

    /* ----------------------------------------------------- unmeasured rules */

    function test_unmeasured_acceptedWhenEmpty() public {
        postOne(unmeasured(NVDAx, Form.Raw, 1000));
        Row memory got = feed.latestFor(NVDAx, Form.Raw, 1000);
        assertEq(got.status, uint8(Status.Unmeasured));
        assertEq(got.markUsd, 0);
        assertEq(got.realisableUsd, 0);
        assertEq(got.fillableUsd, 0);
        // It still records provenance, so a consumer can see it was refreshed.
        assertEq(got.publishedAt, uint48(block.timestamp));
    }

    function test_unmeasured_revertsWithMark() public {
        RowInput memory r = unmeasured(NVDAx, Form.Raw, 1000);
        r.markUsd = 1;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.UnmeasuredRowHasNumbers.selector, 0));
        feed.post(ENGINE_BLOCK, one(r));
    }

    function test_unmeasured_revertsWithRealisable() public {
        RowInput memory r = unmeasured(NVDAx, Form.Raw, 1000);
        r.realisableUsd = 1;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.UnmeasuredRowHasNumbers.selector, 0));
        feed.post(ENGINE_BLOCK, one(r));
    }

    function test_unmeasured_revertsWithFillable() public {
        RowInput memory r = unmeasured(NVDAx, Form.Raw, 1000);
        r.fillableUsd = 1;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.UnmeasuredRowHasNumbers.selector, 0));
        feed.post(ENGINE_BLOCK, one(r));
    }

    function test_unmeasured_revertsWithGap() public {
        RowInput memory r = unmeasured(NVDAx, Form.Raw, 1000);
        r.gapBps = -10;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.NonMeasuredRowHasGap.selector, 0, int32(-10)));
        feed.post(ENGINE_BLOCK, one(r));
    }

    /// @dev The index in the error names which row of the run failed.
    function test_rowShapeErrorCarriesTheRowIndex() public {
        RowInput[] memory rows = new RowInput[](3);
        rows[0] = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000);
        rows[1] = measured(NVDAx, Form.Wrapped, 10000, 220_018_700, 9_959_110_000);
        rows[2] = unmeasured(TSLAx, Form.Raw, 1000);
        rows[2].markUsd = 5;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.UnmeasuredRowHasNumbers.selector, 2));
        feed.post(ENGINE_BLOCK, rows);
    }

    /* ------------------------------------------------------------ freshness */

    function test_isFresh_withinAge() public {
        postOne(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        assertTrue(feed.isFreshFor(NVDAx, Form.Wrapped, 1000, 3600));
    }

    function test_isFresh_falseOnceTooOld() public {
        postOne(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        vm.warp(block.timestamp + 3601);
        assertFalse(feed.isFreshFor(NVDAx, Form.Wrapped, 1000, 3600));
    }

    function test_isFresh_trueExactlyAtTheBoundary() public {
        postOne(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        vm.warp(block.timestamp + 3600);
        assertTrue(feed.isFreshFor(NVDAx, Form.Wrapped, 1000, 3600));
    }

    /// @notice A freshly posted Unmeasured row is still not fresh: freshness is a
    ///         claim about usable numbers, not about publisher liveness.
    function test_isFresh_falseForUnmeasuredHoweverRecent() public {
        postOne(unmeasured(NVDAx, Form.Raw, 1000));
        assertFalse(feed.isFreshFor(NVDAx, Form.Raw, 1000, 3600));
    }

    function test_isFresh_falseForNeverPosted() public view {
        assertFalse(feed.isFreshFor(TSLAx, Form.Wrapped, 1000, type(uint256).max));
    }

    function test_isFresh_trueForAbsentRow() public {
        // Absent is a real measurement; the gate, not the feed, decides to refuse it.
        postOne(absent(NVDAx, Form.Wrapped, 500000, 219_708_100, 293_456_510_000, 372_798_000_000));
        assertTrue(feed.isFreshFor(NVDAx, Form.Wrapped, 500000, 3600));
    }

    /* ------------------------------------------------------- maxFillableUsd */

    function test_maxFillable_measuredContributesFaceValue() public {
        postOne(measured(NVDAx, Form.Wrapped, 10000, 220_018_700, 9_959_110_000));
        assertEq(feed.maxFillableUsd(NVDAx, Form.Wrapped), 10_000 * 1e6);
    }

    function test_maxFillable_absentContributesOnlyWhatFilled() public {
        postOne(absent(NVDAx, Form.Wrapped, 500000, 219_708_100, 293_456_510_000, 372_798_000_000));
        assertEq(feed.maxFillableUsd(NVDAx, Form.Wrapped), 372_798_000_000);
    }

    function test_maxFillable_unmeasuredContributesNothing() public {
        postOne(unmeasured(NVDAx, Form.Wrapped, 100000));
        assertEq(feed.maxFillableUsd(NVDAx, Form.Wrapped), 0);
    }

    function test_maxFillable_takesTheLargestAcrossTiers() public {
        RowInput[] memory rows = new RowInput[](4);
        rows[0] = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000);
        rows[1] = measured(NVDAx, Form.Wrapped, 10000, 220_018_700, 9_959_110_000);
        rows[2] = measured(NVDAx, Form.Wrapped, 100000, 220_018_700, 97_924_170_000);
        rows[3] = absent(NVDAx, Form.Wrapped, 500000, 219_708_100, 293_456_510_000, 372_798_000_000);
        vm.prank(publisher);
        feed.post(ENGINE_BLOCK, rows);
        // The absent tier filled $372,798, more than the largest fully measured tier.
        assertEq(feed.maxFillableUsd(NVDAx, Form.Wrapped), 372_798_000_000);
    }

    function test_maxFillable_isolatedPerForm() public {
        postOne(measured(NVDAx, Form.Wrapped, 100000, 220_018_700, 97_924_170_000));
        assertEq(feed.maxFillableUsd(NVDAx, Form.Wrapped), 100_000 * 1e6);
        assertEq(feed.maxFillableUsd(NVDAx, Form.Raw), 0);
    }

    function test_maxFillableFresh_dropsStaleRows() public {
        postOne(measured(NVDAx, Form.Wrapped, 100000, 220_018_700, 97_924_170_000));
        assertEq(feed.maxFillableUsdFresh(NVDAx, Form.Wrapped, 3600), 100_000 * 1e6);
        vm.warp(block.timestamp + 7200);
        assertEq(feed.maxFillableUsdFresh(NVDAx, Form.Wrapped, 3600), 0);
        // The age-blind view still reports it, which is why the docs point at isFresh.
        assertEq(feed.maxFillableUsd(NVDAx, Form.Wrapped), 100_000 * 1e6);
    }

    /* ----------------------------------------------------------------- keys */

    function test_tiers_areRecordedOnceEach() public {
        RowInput[] memory rows = new RowInput[](2);
        rows[0] = measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000);
        rows[1] = measured(NVDAx, Form.Wrapped, 10000, 220_018_700, 9_959_110_000);
        vm.prank(publisher);
        feed.post(ENGINE_BLOCK, rows);
        vm.prank(publisher);
        feed.post(ENGINE_BLOCK, rows); // same tiers again
        assertEq(feed.tierCount(NVDAx, Form.Wrapped), 2);
        uint32[] memory ts = feed.tiers(NVDAx, Form.Wrapped);
        assertEq(ts[0], 1000);
        assertEq(ts[1], 10000);
    }

    function test_rowKey_separatesFormAndTierAndToken() public view {
        bytes32 a = feed.rowKey(NVDAx, Form.Raw, 1000);
        bytes32 b = feed.rowKey(NVDAx, Form.Wrapped, 1000);
        bytes32 c = feed.rowKey(NVDAx, Form.Raw, 10000);
        bytes32 d = feed.rowKey(TSLAx, Form.Raw, 1000);
        assertTrue(a != b && a != c && a != d && b != c && b != d && c != d);
    }

    function test_latest_unknownKeyReadsBackUnmeasured() public view {
        Row memory got = feed.latest(feed.rowKey(TSLAx, Form.Wrapped, 777));
        assertEq(got.status, uint8(Status.Unmeasured));
        assertEq(got.publishedAt, 0);
        assertEq(got.markUsd, 0);
    }

    function test_expectedGapBps_math() public view {
        // $1,000 tier realising $997.60 is -24 bps.
        assertEq(feed.expectedGapBps(1000, 997_600_000), -24);
        // $100,000 tier realising $97,924.17 is -207 bps (truncated toward zero).
        assertEq(feed.expectedGapBps(100000, 97_924_170_000), -207);
        // Exactly face value.
        assertEq(feed.expectedGapBps(1000, 1_000_000_000), 0);
        // Above face value.
        assertEq(feed.expectedGapBps(1000, 1_010_000_000), 100);
    }

    /* ------------------------------------------------------- overwrite rules */

    function test_laterRunSupersedesEarlierRow() public {
        postOne(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        vm.warp(block.timestamp + 600);
        vm.prank(publisher);
        feed.post(ENGINE_BLOCK + 500, one(measured(NVDAx, Form.Wrapped, 1000, 221_000_000, 998_000_000)));

        Row memory got = feed.latestFor(NVDAx, Form.Wrapped, 1000);
        assertEq(got.realisableUsd, 998_000_000);
        assertEq(got.engineBlock, ENGINE_BLOCK + 500);
        assertEq(got.publishedAt, uint48(block.timestamp));
    }

    function test_measuredRowCanBecomeUnmeasured() public {
        postOne(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        postOne(unmeasured(NVDAx, Form.Wrapped, 1000));
        Row memory got = feed.latestFor(NVDAx, Form.Wrapped, 1000);
        assertEq(got.status, uint8(Status.Unmeasured));
        assertEq(got.realisableUsd, 0);
        assertEq(got.gapBps, 0);
        assertFalse(feed.isFreshFor(NVDAx, Form.Wrapped, 1000, 3600));
    }

    /* ----------------------------------------------------------------- fuzz */

    function testFuzz_measuredGapAlwaysAgreesWithValues(uint32 tier, uint128 realisable) public {
        tier = uint32(bound(tier, 1, 10_000_000));
        realisable = uint128(bound(realisable, 1, uint128(type(uint96).max)));
        int256 gap = gapOf(tier, realisable);
        // Cross-check the local formula against the contract's own.
        assertEq(gap, feed.expectedGapBps(tier, realisable));
        // A gap that fits the stored width is postable; one that does not is out of
        // scope for the feed's 32-bit field.
        if (gap < type(int32).min || gap > type(int32).max) return;

        RowInput memory r = RowInput({
            token: NVDAx,
            form: Form.Wrapped,
            sizeTierUsd: tier,
            markUsd: 1,
            realisableUsd: realisable,
            fillableUsd: 0,
            gapBps: int32(gap),
            status: Status.Measured
        });
        vm.prank(publisher);
        feed.post(ENGINE_BLOCK, one(r));
        assertEq(feed.latestFor(NVDAx, Form.Wrapped, tier).gapBps, int32(gap));
    }

    function testFuzz_nonPublisherNeverPosts(address caller) public {
        vm.assume(caller != publisher);
        RowInput[] memory rows = one(measured(NVDAx, Form.Wrapped, 1000, 220_018_700, 997_600_000));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(StateraFeed.NotPublisher.selector, caller));
        feed.post(ENGINE_BLOCK, rows);
    }
}
