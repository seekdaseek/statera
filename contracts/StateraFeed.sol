// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Form, Status, Row, RowInput, IStateraFeed} from "./IStateraFeed.sol";

/**
 * @title StateraFeed
 * @notice Onchain record of what a tokenized stock is worth on paper and what it
 *         would actually fetch if sold into live X Layer liquidity.
 *
 * Each row is keyed by (token, form, size tier) and carries three numbers plus the
 * provenance needed to judge them: the mark, the realisable value for selling that
 * tier, the gap between them in basis points, and — when the pools cannot fill the
 * tier — how much of it they could.
 *
 * WHY THE CONTRACT POLICES ITS OWN ROWS
 *
 * A feed that will accept anything is only as good as its publisher's discipline,
 * and a consumer cannot tell a real zero from a missing number. So the shape of a
 * row is enforced here rather than trusted:
 *
 *   Measured    must carry a mark, a realisable value, and a gap that AGREES with
 *               them. gapBps is recomputed from realisableUsd against the tier size
 *               and must match within GAP_TOLERANCE_BPS. The gap is therefore not
 *               forgeable independently of the values it summarises.
 *   Absent      the pools exist but could not fill the tier. Must carry a non-zero
 *               fillableUsd and must NOT carry a gap: there is no honest gap for a
 *               sale that cannot complete.
 *   Unmeasured  the engine could not measure. Must carry no numbers at all — not a
 *               mark, not a realisable value, not a fillable amount, not a gap.
 *
 * A whole engine run posts in one transaction, and each row emits its own event, so
 * the series is reconstructible from logs alone by anyone who does not trust the
 * current storage.
 *
 * The publisher is immutable. There is no owner, no upgrade path and no way to
 * rewrite history: a posted row can be superseded by a later run but never edited,
 * and nobody — including the deployer — can repoint the feed at a different
 * publisher. The cost of that choice is that a lost publisher key ends the feed.
 * That is deliberate; a feed a stranger can silently take over is not worth reading.
 */
contract StateraFeed is IStateraFeed {
    /* ------------------------------------------------------------ constants */

    /// @notice Tolerance when checking a Measured row's gap against its values.
    /// @dev One basis point, to absorb the publisher's rounding. Wide enough that an
    ///      honest post never fails, far too narrow to hide a misstated gap.
    int256 public constant GAP_TOLERANCE_BPS = 1;

    /// @notice A Measured row may not claim proceeds above this multiple of the
    ///         tier's face value.
    /// @dev The pools really can pay slightly above the mark — venue basis is a few
    ///      basis points either way — so a bound is needed, not a prohibition. But a
    ///      row claiming to realise twice face is not basis, it is a broken decimal
    ///      somewhere upstream, and a consumer that believes it lends against money
    ///      that does not exist. Two times face is generous and still blocks that.
    uint256 public constant MAX_REALISABLE_MULTIPLE = 2;

    uint256 private constant USD_SCALE = 1e6;
    int256 private constant BPS = 10_000;

    /* -------------------------------------------------------------- storage */

    /// @notice The only address that may post. Set once, at deploy, forever.
    address public immutable publisher;

    /// @notice rowKey => latest row.
    mapping(bytes32 => Row) private _rows;

    /// @notice seriesKey => the size tiers ever posted for it, in first-seen order.
    mapping(bytes32 => uint32[]) private _tiers;

    /// @notice seriesKey => tier => whether it is already in `_tiers`.
    mapping(bytes32 => mapping(uint32 => bool)) private _tierKnown;

    /// @notice Engine block of the most recent run. Never goes backwards.
    uint40 public lastEngineBlock;

    /// @notice Timestamp of the most recent run.
    uint48 public lastPublishedAt;

    /// @notice How many runs have been posted.
    uint64 public runCount;

    /* --------------------------------------------------------------- events */

    event RowPosted(
        bytes32 indexed rowKey,
        address indexed token,
        Form indexed form,
        uint32 sizeTierUsd,
        uint128 markUsd,
        uint128 realisableUsd,
        uint128 fillableUsd,
        int32 gapBps,
        Status status,
        uint40 engineBlock,
        uint48 publishedAt
    );

    event RunPosted(uint40 indexed engineBlock, uint256 rowCount, uint48 publishedAt, uint64 runIndex);

    /* --------------------------------------------------------------- errors */

    error NotPublisher(address caller);
    error NoRows();
    error ZeroToken();
    error ZeroTier();
    error EngineBlockWentBackwards(uint40 posted, uint40 last);
    error ZeroEngineBlock();
    /// @dev A Measured row must carry both values and a gap consistent with them.
    error MeasuredRowIncomplete(uint256 index);
    error GapInconsistent(uint256 index, int32 posted, int256 expected);
    /// @dev An Absent row must state what it could fill and must not state a gap.
    error AbsentRowNeedsFillable(uint256 index);
    error NonMeasuredRowHasGap(uint256 index, int32 gapBps);
    /// @dev A fully filled tier has nothing left to "fill"; the field would be noise.
    error MeasuredRowHasFillable(uint256 index);
    /// @dev Absent means the tier could NOT be filled, so what did fill must be less.
    error AbsentFillableNotBelowTier(uint256 index, uint128 fillableUsd, uint256 tierFaceUsd);
    /// @dev Proceeds far above face are a decimal error, not a measurement.
    error RealisableAboveBound(uint256 index, uint128 realisableUsd, uint256 maxAllowed);
    /// @dev An Unmeasured row must carry no numbers whatsoever.
    error UnmeasuredRowHasNumbers(uint256 index);

    /* ---------------------------------------------------------- constructor */

    constructor(address publisher_) {
        if (publisher_ == address(0)) revert ZeroToken();
        publisher = publisher_;
    }

    /* ------------------------------------------------------------- posting */

    /**
     * @notice Post an entire engine run.
     * @param engineBlock The X Layer block the engine read. Must not go backwards.
     * @param rows Every row of the run. Each emits its own RowPosted event.
     */
    function post(uint40 engineBlock, RowInput[] calldata rows) external {
        if (msg.sender != publisher) revert NotPublisher(msg.sender);
        if (rows.length == 0) revert NoRows();
        if (engineBlock == 0) revert ZeroEngineBlock();
        if (engineBlock < lastEngineBlock) revert EngineBlockWentBackwards(engineBlock, lastEngineBlock);

        uint48 now48 = uint48(block.timestamp);

        for (uint256 i = 0; i < rows.length; ++i) {
            RowInput calldata r = rows[i];
            if (r.token == address(0)) revert ZeroToken();
            if (r.sizeTierUsd == 0) revert ZeroTier();

            _checkRowShape(r, i);

            bytes32 rk = rowKey(r.token, r.form, r.sizeTierUsd);
            _rows[rk] = Row({
                markUsd: r.markUsd,
                realisableUsd: r.realisableUsd,
                fillableUsd: r.fillableUsd,
                gapBps: r.gapBps,
                status: uint8(r.status),
                engineBlock: engineBlock,
                publishedAt: now48
            });

            bytes32 sk = seriesKey(r.token, r.form);
            if (!_tierKnown[sk][r.sizeTierUsd]) {
                _tierKnown[sk][r.sizeTierUsd] = true;
                _tiers[sk].push(r.sizeTierUsd);
            }

            _emitRow(rk, r, engineBlock, now48);
        }

        lastEngineBlock = engineBlock;
        lastPublishedAt = now48;
        uint64 idx = runCount + 1;
        runCount = idx;
        emit RunPosted(engineBlock, rows.length, now48, idx);
    }

    /// @dev Extracted purely to keep the posting loop off the stack limit: eleven
    ///      event fields plus the loop's own locals overflow it otherwise.
    function _emitRow(bytes32 rk, RowInput calldata r, uint40 engineBlock, uint48 now48) private {
        emit RowPosted(
            rk,
            r.token,
            r.form,
            r.sizeTierUsd,
            r.markUsd,
            r.realisableUsd,
            r.fillableUsd,
            r.gapBps,
            r.status,
            engineBlock,
            now48
        );
    }

    /// @dev The status rules described at the top of the file, enforced.
    function _checkRowShape(RowInput calldata r, uint256 i) private pure {
        uint256 face = uint256(r.sizeTierUsd) * USD_SCALE;

        if (r.status == Status.Measured) {
            if (r.markUsd == 0 || r.realisableUsd == 0) revert MeasuredRowIncomplete(i);
            // A filled tier has no unfilled remainder to describe.
            if (r.fillableUsd != 0) revert MeasuredRowHasFillable(i);
            // Sanity bound, so one bad decimal cannot mint credit downstream.
            uint256 maxRealisable = face * MAX_REALISABLE_MULTIPLE;
            if (uint256(r.realisableUsd) > maxRealisable) {
                revert RealisableAboveBound(i, r.realisableUsd, maxRealisable);
            }
            int256 expected = expectedGapBps(r.sizeTierUsd, r.realisableUsd);
            int256 diff = int256(r.gapBps) - expected;
            if (diff < 0) diff = -diff;
            if (diff > GAP_TOLERANCE_BPS) revert GapInconsistent(i, r.gapBps, expected);
            return;
        }

        // Neither Absent nor Unmeasured may claim a gap.
        if (r.gapBps != 0) revert NonMeasuredRowHasGap(i, r.gapBps);

        if (r.status == Status.Absent) {
            if (r.fillableUsd == 0) revert AbsentRowNeedsFillable(i);
            // "Absent" asserts the tier could not be filled. A fillable amount at or
            // above the tier's face value contradicts that, and would also inflate
            // maxFillableUsd past anything actually observed.
            if (uint256(r.fillableUsd) >= face) {
                revert AbsentFillableNotBelowTier(i, r.fillableUsd, face);
            }
            return;
        }

        // Unmeasured: no numbers at all.
        if (r.markUsd != 0 || r.realisableUsd != 0 || r.fillableUsd != 0) revert UnmeasuredRowHasNumbers(i);
    }

    /* ----------------------------------------------------------------- keys */

    /// @notice Key of one row: an asset, a form, and a size tier.
    function rowKey(address token, Form form, uint32 sizeTierUsd) public pure returns (bytes32) {
        return keccak256(abi.encode(token, form, sizeTierUsd));
    }

    /// @notice Key of a series: every tier of one asset in one form.
    function seriesKey(address token, Form form) public pure returns (bytes32) {
        return keccak256(abi.encode(token, form));
    }

    /// @notice The gap a Measured row must report, in basis points.
    /// @dev Proceeds against the tier's face value. Truncates toward zero, which is
    ///      why the publisher is allowed GAP_TOLERANCE_BPS of slack.
    function expectedGapBps(uint32 sizeTierUsd, uint128 realisableUsd) public pure returns (int256) {
        int256 face = int256(uint256(sizeTierUsd) * USD_SCALE);
        return ((int256(uint256(realisableUsd)) - face) * BPS) / face;
    }

    /* ---------------------------------------------------------------- views */

    /// @notice Latest row for a key. An unknown key reads back as all zeros, i.e. Unmeasured.
    function latest(bytes32 rk) external view returns (Row memory) {
        return _rows[rk];
    }

    /// @notice Latest row, addressed by its parts.
    function latestFor(address token, Form form, uint32 sizeTierUsd) external view returns (Row memory) {
        return _rows[rowKey(token, form, sizeTierUsd)];
    }

    /**
     * @notice Whether a row is both a real measurement and recent enough.
     * @dev Unmeasured is never fresh, however recently it was posted: freshness is a
     *      claim about usable numbers, not about publisher liveness.
     */
    function isFresh(bytes32 rk, uint256 maxAgeSeconds) public view returns (bool) {
        Row storage row = _rows[rk];
        if (row.publishedAt == 0) return false;
        if (row.status == uint8(Status.Unmeasured)) return false;
        return block.timestamp - uint256(row.publishedAt) <= maxAgeSeconds;
    }

    /// @notice isFresh, addressed by parts.
    function isFreshFor(address token, Form form, uint32 sizeTierUsd, uint256 maxAgeSeconds)
        external
        view
        returns (bool)
    {
        return isFresh(rowKey(token, form, sizeTierUsd), maxAgeSeconds);
    }

    /**
     * @notice The largest sale, in USD (6 decimals), this feed has evidence can be filled.
     * @dev Measured tiers contribute their whole face value, because the pools absorbed
     *      it. Absent tiers contribute only the part that filled. Unmeasured tiers
     *      contribute nothing. Stale rows are NOT excluded here — callers that care
     *      about age must pair this with isFresh; see maxFillableUsdFresh.
     */
    function maxFillableUsd(address token, Form form) public view returns (uint256 best) {
        bytes32 sk = seriesKey(token, form);
        uint32[] storage ts = _tiers[sk];
        for (uint256 i = 0; i < ts.length; ++i) {
            uint32 tier = ts[i];
            Row storage row = _rows[rowKey(token, form, tier)];
            uint256 candidate = 0;
            if (row.status == uint8(Status.Measured)) {
                candidate = uint256(tier) * USD_SCALE;
            } else if (row.status == uint8(Status.Absent)) {
                candidate = uint256(row.fillableUsd);
            }
            if (candidate > best) best = candidate;
        }
    }

    /// @notice maxFillableUsd, counting only rows younger than maxAgeSeconds.
    function maxFillableUsdFresh(address token, Form form, uint256 maxAgeSeconds)
        external
        view
        returns (uint256 best)
    {
        bytes32 sk = seriesKey(token, form);
        uint32[] storage ts = _tiers[sk];
        for (uint256 i = 0; i < ts.length; ++i) {
            uint32 tier = ts[i];
            bytes32 rk = rowKey(token, form, tier);
            if (!isFresh(rk, maxAgeSeconds)) continue;
            Row storage row = _rows[rk];
            uint256 candidate = 0;
            if (row.status == uint8(Status.Measured)) {
                candidate = uint256(tier) * USD_SCALE;
            } else if (row.status == uint8(Status.Absent)) {
                candidate = uint256(row.fillableUsd);
            }
            if (candidate > best) best = candidate;
        }
    }

    /// @notice Size tiers ever posted for a series, in first-seen order (not sorted).
    function tiers(address token, Form form) external view returns (uint32[] memory) {
        return _tiers[seriesKey(token, form)];
    }

    /// @notice Number of tiers posted for a series.
    function tierCount(address token, Form form) external view returns (uint256) {
        return _tiers[seriesKey(token, form)].length;
    }
}
