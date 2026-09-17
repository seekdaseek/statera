// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StateraFeed} from "../StateraFeed.sol";
import {CollateralGate} from "../CollateralGate.sol";
import {Form, Status, Row, RowInput, IStateraFeed} from "../IStateraFeed.sol";

interface IERC20Meta {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
}

interface IWrapper {
    function asset() external view returns (address);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

/**
 * @notice Deploys the pair onto a fork of X Layer mainnet and round-trips a run
 *         through it, so the contracts are exercised against the real chain's
 *         state, chain id and clock rather than a bare EVM.
 *
 * Run with:  forge test --match-path contracts/test/ForkRoundTrip.t.sol --fork-url https://rpc.xlayer.tech
 *
 * Without --fork-url every test here no-ops rather than failing, so the offline
 * suite stays green on a machine with no network.
 */
contract ForkRoundTripTest is Test {
    address constant NVDAx = 0xc845b2894dBddd03858fd2D643B4eF725fE0849d;
    address constant wNVDAx = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address constant SPYx = 0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48;
    address constant wSPYx = 0xE7E553Cd128F0011777323A0b44a7b96EA1CB540;

    uint256 constant MAX_AGE = 1800;
    uint16 constant LTV = 5000;

    StateraFeed feed;
    CollateralGate gate;
    address publisher = address(0xBEEF);

    bool forked;

    function setUp() public {
        forked = block.chainid == 196;
        feed = new StateraFeed(publisher);
        gate = new CollateralGate(IStateraFeed(address(feed)), MAX_AGE);
    }

    function gapOf(uint32 tier, uint128 realisable) internal pure returns (int256) {
        int256 face = int256(uint256(tier) * 1e6);
        return ((int256(uint256(realisable)) - face) * 10_000) / face;
    }

    /// @notice The fork really is X Layer and the assets statera reads are there.
    function test_fork_assetsExistOnChain() public view {
        if (!forked) return;
        assertEq(block.chainid, 196);
        assertEq(IERC20Meta(NVDAx).symbol(), "NVDAx");
        assertEq(IERC20Meta(wNVDAx).symbol(), "wNVDAx");
        assertEq(IERC20Meta(NVDAx).decimals(), 18);
        assertGt(IERC20Meta(NVDAx).totalSupply(), 0);
        // The wrapper is an ERC-4626 over the raw xStock.
        assertEq(IWrapper(wNVDAx).asset(), NVDAx);
        assertEq(IWrapper(wSPYx).asset(), SPYx);
    }

    /**
     * @notice The wrapper's share rate is exactly the rebasing multiplier, which is
     *         why statera quotes the two forms at different marks. Read live.
     */
    function test_fork_wrapperShareRateIsAtLeastOne() public view {
        if (!forked) return;
        uint256 nvda = IWrapper(wNVDAx).convertToAssets(1e18);
        uint256 spy = IWrapper(wSPYx).convertToAssets(1e18);
        assertGe(nvda, 1e18, "a share can never be worth less than one asset here");
        assertGe(spy, 1e18);
        // Sanity bound: these accrue slowly, so a 10% jump would mean a decoding bug.
        assertLt(nvda, 11e17);
        assertLt(spy, 11e17);
    }

    /// @notice Post a run on the fork and read it back through the gate.
    function test_fork_postAndReadThroughGate() public {
        if (!forked) return;

        uint40 engineBlock = uint40(block.number);
        uint128 mark = 220_018_700;
        uint128 r1k = 997_600_000;
        uint128 r100k = 97_924_170_000;

        RowInput[] memory rows = new RowInput[](3);
        rows[0] = RowInput(NVDAx, Form.Wrapped, 1000, mark, r1k, 0, int32(gapOf(1000, r1k)), Status.Measured);
        rows[1] = RowInput(NVDAx, Form.Wrapped, 100000, mark, r100k, 0, int32(gapOf(100000, r100k)), Status.Measured);
        rows[2] = RowInput(NVDAx, Form.Wrapped, 500000, mark, 293_456_510_000, 372_798_000_000, 0, Status.Absent);

        vm.prank(publisher);
        feed.post(engineBlock, rows);

        // Stored against the fork's own block and clock.
        Row memory got = feed.latestFor(NVDAx, Form.Wrapped, 100000);
        assertEq(got.engineBlock, engineBlock);
        assertEq(got.publishedAt, uint48(block.timestamp));
        assertEq(got.realisableUsd, r100k);
        assertTrue(feed.isFreshFor(NVDAx, Form.Wrapped, 100000, MAX_AGE));

        // The gate values $100k of collateral at the realisable value, not the mark.
        uint256 limit = gate.borrowLimitUsd(NVDAx, Form.Wrapped, 100_000 * 1e6, LTV);
        assertEq(limit, (uint256(r100k) * LTV) / 10_000);
        assertLt(limit, (uint256(100_000 * 1e6) * LTV) / 10_000);

        // And refuses the size the pools cannot fill.
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

        // maxFillableUsd reflects the absent tier's partial fill.
        assertEq(feed.maxFillableUsd(NVDAx, Form.Wrapped), 372_798_000_000);
    }

    /// @notice Freshness uses the fork's real timestamp, so staleness works there too.
    function test_fork_stalenessUsesRealClock() public {
        if (!forked) return;
        uint128 r1k = 997_600_000;
        RowInput[] memory rows = new RowInput[](1);
        rows[0] = RowInput(NVDAx, Form.Wrapped, 1000, 220_018_700, r1k, 0, int32(gapOf(1000, r1k)), Status.Measured);
        vm.prank(publisher);
        feed.post(uint40(block.number), rows);

        assertGt(gate.borrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, LTV), 0);
        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.expectRevert();
        gate.borrowLimitUsd(NVDAx, Form.Wrapped, 1_000 * 1e6, LTV);
    }

    /// @notice Gas for a realistic 18-row run, measured on the fork.
    function test_fork_gasForFullRun() public {
        if (!forked) return;
        RowInput[] memory rows = new RowInput[](18);
        address[3] memory toks = [NVDAx, SPYx, 0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0];
        uint32[3] memory tiers = [uint32(1000), 10000, 100000];
        uint256 n = 0;
        for (uint256 t = 0; t < 3; ++t) {
            for (uint256 f = 0; f < 2; ++f) {
                for (uint256 s = 0; s < 3; ++s) {
                    uint128 realisable = uint128(uint256(tiers[s]) * 1e6 * 997 / 1000);
                    rows[n++] = RowInput(
                        toks[t],
                        f == 0 ? Form.Raw : Form.Wrapped,
                        tiers[s],
                        220_018_700,
                        realisable,
                        0,
                        int32(gapOf(tiers[s], realisable)),
                        Status.Measured
                    );
                }
            }
        }
        vm.prank(publisher);
        uint256 before = gasleft();
        feed.post(uint40(block.number), rows);
        uint256 used = before - gasleft();
        emit log_named_uint("gas for an 18-row post (first write, cold slots)", used);
        assertLt(used, 2_000_000);

        // A second identical post writes warm slots: the steady-state cost.
        vm.prank(publisher);
        before = gasleft();
        feed.post(uint40(block.number), rows);
        uint256 used2 = before - gasleft();
        emit log_named_uint("gas for an 18-row post (steady state)", used2);
        assertLt(used2, used);
    }
}
