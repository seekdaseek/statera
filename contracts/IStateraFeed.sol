// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Which form of the asset a row describes.
/// @dev Raw is the rebasing xStock; Wrapped is the ERC-4626 wrapper that actually
///      trades in the pools. Ordering is part of the ABI: 0 = Raw, 1 = Wrapped.
enum Form {
    Raw,
    Wrapped
}

/// @notice Measurement outcome. Ordering is part of the ABI: 0/1/2.
enum Status {
    Unmeasured,
    Measured,
    Absent
}

/// @notice Stored row. Packs into exactly two storage slots.
struct Row {
    uint128 markUsd; // USD, 6 decimals, per one token of `form`
    uint128 realisableUsd; // USD, 6 decimals, proceeds of selling the tier
    uint128 fillableUsd; // USD, 6 decimals, meaningful only when Absent
    int32 gapBps; // basis points; negative means worse than the mark
    uint8 status; // Status
    uint40 engineBlock; // X Layer block the engine read
    uint48 publishedAt; // block.timestamp of the post
}

/// @notice One row as submitted by the publisher.
struct RowInput {
    address token;
    Form form;
    uint32 sizeTierUsd; // whole USD, e.g. 1000 / 10000 / 100000
    uint128 markUsd;
    uint128 realisableUsd;
    uint128 fillableUsd;
    int32 gapBps;
    Status status;
}

/**
 * @title IStateraFeed
 * @notice The read surface a consumer needs. Consumers should depend on this, not on
 *         the implementation, so a future feed can be swapped in without touching them.
 */
interface IStateraFeed {
    function publisher() external view returns (address);

    function lastEngineBlock() external view returns (uint40);

    function lastPublishedAt() external view returns (uint48);

    function runCount() external view returns (uint64);

    function rowKey(address token, Form form, uint32 sizeTierUsd) external pure returns (bytes32);

    function seriesKey(address token, Form form) external pure returns (bytes32);

    function expectedGapBps(uint32 sizeTierUsd, uint128 realisableUsd) external pure returns (int256);

    function latest(bytes32 rk) external view returns (Row memory);

    function latestFor(address token, Form form, uint32 sizeTierUsd) external view returns (Row memory);

    function isFresh(bytes32 rk, uint256 maxAgeSeconds) external view returns (bool);

    function isFreshFor(address token, Form form, uint32 sizeTierUsd, uint256 maxAgeSeconds)
        external
        view
        returns (bool);

    function maxFillableUsd(address token, Form form) external view returns (uint256);

    function maxFillableUsdFresh(address token, Form form, uint256 maxAgeSeconds) external view returns (uint256);

    function tiers(address token, Form form) external view returns (uint32[] memory);

    function tierCount(address token, Form form) external view returns (uint256);

    function post(uint40 engineBlock, RowInput[] calldata rows) external;
}
