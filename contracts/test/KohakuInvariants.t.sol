// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {KohakuBase} from "./KohakuBase.t.sol";
import {KohakuClearingHouse} from "../src/KohakuClearingHouse.sol";

/// Drives the clearing house through random epochs, settlements, defaults and payouts.
contract ClearingHandler is KohakuBase {
    uint64 public lastFinalized;
    uint64[5] internal nonces;
    int256 public ghostNetSumOfLastEpoch;
    uint256 public epochsFinalized;
    uint256 public totalPaidOut;
    uint256 public totalSettledIn;
    uint256 public totalSeized;

    constructor() {
        setUp();
    }

    function runEpoch(uint256 seed, uint8 count) external {
        uint64 epochId = ch.currentEpoch();
        uint256 n = bound(count, 0, 12);
        KohakuClearingHouse.IOU[] memory ious = new KohakuClearingHouse.IOU[](n);
        uint256 idx;
        for (uint256 b = 0; b < 5 && idx < n; b++) {
            uint256 take = (b == 4) ? n - idx : bound(uint256(keccak256(abi.encode(seed, b))), 0, n - idx);
            for (uint256 k = 0; k < take; k++) {
                uint256 r = uint256(keccak256(abi.encode(seed, b, k)));
                nonces[b] += 1;
                ious[idx++] = _iou(b, (b + 1 + (r % 4)) % 5, 1 + (r >> 8) % 5_000, epochId, nonces[b]);
            }
        }
        _postAndFinalize(epochId, ious);
        lastFinalized = epochId;
        epochsFinalized++;
        int256 sum;
        uint256[] memory parts = ch.getParticipants(epochId);
        for (uint256 i = 0; i < parts.length; i++) {
            (,, int256 net,) = ch.getPosition(epochId, parts[i]);
            sum += net;
        }
        ghostNetSumOfLastEpoch = sum;
    }

    function settleSome(uint256 seed) external {
        if (lastFinalized == 0) return;
        uint64 epochId = uint64(bound(seed, 1, lastFinalized));
        if (ch.getEpoch(epochId).status != KohakuClearingHouse.EpochStatus.Finalized) return;
        uint256[] memory parts = ch.getParticipants(epochId);
        for (uint256 i = 0; i < parts.length; i++) {
            (,, int256 net, KohakuClearingHouse.PositionState st) = ch.getPosition(epochId, parts[i]);
            if (st != KohakuClearingHouse.PositionState.Owes) continue;
            if (uint256(keccak256(abi.encode(seed, i))) % 3 == 0) continue; // leave some unpaid
            if (usdc.balanceOf(_signerOf(parts[i])) < uint256(-net)) continue;
            _settle(epochId, parts[i], keccak256(abi.encode("p", epochId, parts[i])));
            totalSettledIn += uint256(-net);
        }
    }

    function defaultLate(uint256 seed) external {
        if (lastFinalized == 0) return;
        uint64 epochId = uint64(bound(seed, 1, lastFinalized));
        KohakuClearingHouse.Epoch memory e = ch.getEpoch(epochId);
        if (e.status != KohakuClearingHouse.EpochStatus.Finalized) return;
        vm.warp(e.settleDeadline + 1);
        uint256[] memory parts = ch.getParticipants(epochId);
        for (uint256 i = 0; i < parts.length; i++) {
            (,, int256 net, KohakuClearingHouse.PositionState st) = ch.getPosition(epochId, parts[i]);
            if (st == KohakuClearingHouse.PositionState.Owes) {
                ch.declareDefault(epochId, parts[i]);
                totalSeized += uint256(-net);
            }
        }
    }

    function payoutAny(uint256 seed) external {
        if (lastFinalized == 0) return;
        uint64 epochId = uint64(bound(seed, 1, lastFinalized));
        KohakuClearingHouse.Epoch memory e = ch.getEpoch(epochId);
        if (e.status != KohakuClearingHouse.EpochStatus.Finalized || e.openDebtors != 0) return;
        ch.payout(epochId);
        totalPaidOut += e.netVolume;
    }

    // expose fixture state to the invariant contract
    function usdcAddr() external view returns (address) {
        return address(usdc);
    }

    function chAddr() external view returns (address) {
        return address(ch);
    }

    function vaultAddr() external view returns (address) {
        return address(vault);
    }

    function agentIds() external view returns (uint256[] memory ids) {
        ids = new uint256[](agents.length);
        for (uint256 i = 0; i < agents.length; i++) ids[i] = agents[i].id;
    }
}

contract KohakuInvariantsTest is KohakuBase {
    ClearingHandler internal handler;

    function setUp() public override {
        handler = new ClearingHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = ClearingHandler.runEpoch.selector;
        selectors[1] = ClearingHandler.settleSome.selector;
        selectors[2] = ClearingHandler.defaultLate.selector;
        selectors[3] = ClearingHandler.payoutAny.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Every epoch's net positions sum to exactly zero.
    function invariant_NetPositionsSumToZero() public view {
        assertEq(handler.ghostNetSumOfLastEpoch(), 0);
    }

    /// The pool always holds at least what it owes creditors.
    function invariant_PoolSolvent() public view {
        KohakuClearingHouse c = KohakuClearingHouse(handler.chAddr());
        assertGe(usdcBalance(handler.chAddr()), c.accountedBalance());
    }

    /// The vault holds exactly the sum of all agents' collateral, and nothing is over-locked.
    function invariant_VaultBacksCollateral() public view {
        uint256[] memory ids = handler.agentIds();
        uint256 sum;
        for (uint256 i = 0; i < ids.length; i++) {
            (bool ok, bytes memory data) =
                handler.vaultAddr().staticcall(abi.encodeWithSignature("accountOf(uint256)", ids[i]));
            require(ok);
            (uint256 total, uint256 locked,,) = abi.decode(data, (uint256, uint256, uint256, uint64));
            assertLe(locked, total);
            sum += total;
        }
        assertEq(usdcBalance(handler.vaultAddr()), sum);
    }

    /// Conservation: everything that came in (HSP settlements + seized collateral) is either
    /// paid out to creditors or still accounted for in the pool. Nothing is created or lost.
    function invariant_ValueConserved() public view {
        KohakuClearingHouse c = KohakuClearingHouse(handler.chAddr());
        assertEq(handler.totalSettledIn() + handler.totalSeized(), handler.totalPaidOut() + c.accountedBalance());
    }

    function usdcBalance(address who) internal view returns (uint256) {
        (bool ok, bytes memory data) = handler.usdcAddr().staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        require(ok);
        return abi.decode(data, (uint256));
    }
}
