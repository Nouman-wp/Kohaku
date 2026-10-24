// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {KohakuBase} from "./KohakuBase.t.sol";
import {KohakuClearingHouse} from "../src/KohakuClearingHouse.sol";
import {KohakuCollateralVault} from "../src/KohakuCollateralVault.sol";

contract KohakuClearingHouseTest is KohakuBase {
    // A loop of debts: 0 -> 1 -> 2 -> 0 plus a few extra calls. Gross 11 calls, net small.
    function _loopEpoch(uint64 epochId, uint64 nonceBase) internal view returns (KohakuClearingHouse.IOU[] memory ious) {
        ious = new KohakuClearingHouse.IOU[](6);
        // sorted by (buyer, nonce)
        ious[0] = _iou(0, 1, 400, epochId, nonceBase + 1); // agent0 buys from agent1
        ious[1] = _iou(0, 1, 400, epochId, nonceBase + 2);
        ious[2] = _iou(0, 3, 900, epochId, nonceBase + 3);
        ious[3] = _iou(1, 2, 700, epochId, nonceBase + 1);
        ious[4] = _iou(2, 0, 500, epochId, nonceBase + 1);
        ious[5] = _iou(2, 1, 100, epochId, nonceBase + 2);
    }

    function test_HappyPath_NetSettlePayout() public {
        KohakuClearingHouse.IOU[] memory ious = _loopEpoch(1, 0);
        _postAndFinalize(1, ious);

        KohakuClearingHouse.Epoch memory e = ch.getEpoch(1);
        assertEq(uint8(e.status), uint8(KohakuClearingHouse.EpochStatus.Finalized));
        assertEq(e.iouCount, 6);
        assertEq(e.grossVolume, 3000);
        // nets: a0 = 500 - 1700 = -1200 ; a1 = 900 - 700 = +200 ; a2 = 700 - 600 = +100 ; a3 = +900
        assertEq(e.netVolume, 1200);
        assertEq(e.debtorCount, 1);
        assertEq(e.creditorCount, 3);
        assertEq(ch.currentEpoch(), 2);

        // the debtor's net debit is locked
        assertEq(vault.accountOf(agents[0].id).locked, 1200);

        uint256 b1 = usdc.balanceOf(agents[1].signer);
        uint256 b2 = usdc.balanceOf(agents[2].signer);
        uint256 b3 = usdc.balanceOf(agents[3].signer);

        _settle(1, agents[0].id, keccak256("hsp-payment-1"));
        assertEq(vault.accountOf(agents[0].id).locked, 0);
        ch.payout(1);

        assertEq(usdc.balanceOf(agents[1].signer) - b1, 200);
        assertEq(usdc.balanceOf(agents[2].signer) - b2, 100);
        assertEq(usdc.balanceOf(agents[3].signer) - b3, 900);
        assertEq(ch.accountedBalance(), 0);
        assertEq(usdc.balanceOf(address(ch)), 0);

        e = ch.getEpoch(1);
        assertEq(uint8(e.status), uint8(KohakuClearingHouse.EpochStatus.Settled));
        assertTrue(e.receiptHash != bytes32(0));
    }

    function test_ChunkedPostingMatchesSinglePost() public {
        KohakuClearingHouse.IOU[] memory ious = _loopEpoch(1, 0);
        bytes[] memory sigs = _signAll(ious);
        KohakuClearingHouse.IOU[] memory a = new KohakuClearingHouse.IOU[](3);
        KohakuClearingHouse.IOU[] memory b = new KohakuClearingHouse.IOU[](3);
        bytes[] memory sa = new bytes[](3);
        bytes[] memory sb = new bytes[](3);
        for (uint256 i = 0; i < 3; i++) {
            a[i] = ious[i];
            sa[i] = sigs[i];
            b[i] = ious[i + 3];
            sb[i] = sigs[i + 3];
        }
        vm.startPrank(clearer);
        ch.postIous(1, a, sa);
        ch.postIous(1, b, sb);
        (,,, bytes32 ph) = _positions(ious);
        ch.finalizeEpoch(1, _iouSetHash(ious), ph);
        vm.stopPrank();
        assertEq(ch.getEpoch(1).grossVolume, 3000);
    }

    function test_RevertWhen_IouPostedTwiceInEpoch() public {
        KohakuClearingHouse.IOU[] memory ious = new KohakuClearingHouse.IOU[](2);
        ious[0] = _iou(0, 1, 400, 1, 1);
        ious[1] = ious[0];
        bytes[] memory sigs = _signAll(ious);
        vm.prank(clearer);
        vm.expectRevert();
        ch.postIous(1, ious, sigs);
    }

    function test_RevertWhen_DuplicateAcrossChunks() public {
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = _iou(0, 1, 400, 1, 1);
        bytes[] memory sigs = _signAll(one);
        vm.startPrank(clearer);
        ch.postIous(1, one, sigs);
        vm.expectRevert();
        ch.postIous(1, one, sigs);
        vm.stopPrank();
    }

    function test_RevertWhen_IouReplayedInLaterEpoch() public {
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = _iou(0, 1, 400, 1, 1);
        _postAndFinalize(1, one);
        bytes[] memory sigs = _signAll(one);
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.IouEpochMismatch.selector, uint64(2), uint64(1)));
        ch.postIous(2, one, sigs);
    }

    function test_RevertWhen_NonceReusedInLaterEpoch() public {
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = _iou(0, 1, 400, 1, 7);
        _postAndFinalize(1, one);
        // same buyer, same nonce, re-signed for epoch 2: still rejected
        one[0] = _iou(0, 1, 400, 2, 7);
        bytes[] memory sigs = _signAll(one);
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.NonceReused.selector, agents[0].id, uint64(7), uint64(7)));
        ch.postIous(2, one, sigs);
    }

    function test_RevertWhen_IouAlteredAfterSigning() public {
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = _iou(0, 1, 400, 1, 1);
        bytes[] memory sigs = _signAll(one);
        one[0].amount = 40_000; // tamper
        vm.prank(clearer);
        vm.expectRevert();
        ch.postIous(1, one, sigs);
    }

    function test_RevertWhen_SignedBySomeoneElse() public {
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = _iou(0, 1, 400, 1, 1);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(agents[1].pk, one[0]); // the seller signs its own IOU
        vm.prank(clearer);
        vm.expectRevert();
        ch.postIous(1, one, sigs);
    }

    function test_RevertWhen_WrongToken() public {
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = _iou(0, 1, 400, 1, 1);
        one[0].token = address(0xBEEF);
        bytes[] memory sigs = _signAll(one);
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.WrongToken.selector, address(0xBEEF)));
        ch.postIous(1, one, sigs);
    }

    function test_RevertWhen_SelfDealing() public {
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = _iou(0, 0, 400, 1, 1);
        bytes[] memory sigs = _signAll(one);
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.SelfDealing.selector, agents[0].id));
        ch.postIous(1, one, sigs);
    }

    function test_RevertWhen_NotClearer() public {
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = _iou(0, 1, 400, 1, 1);
        bytes[] memory sigs = _signAll(one);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.NotClearer.selector, address(this)));
        ch.postIous(1, one, sigs);
    }

    function test_RevertWhen_FinalizedTwice() public {
        KohakuClearingHouse.IOU[] memory ious = _loopEpoch(1, 0);
        _postAndFinalize(1, ious);
        (,,, bytes32 ph) = _positions(ious);
        bytes32 ih = _iouSetHash(ious);
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.WrongEpoch.selector, uint64(2), uint64(1)));
        ch.finalizeEpoch(1, ih, ph);
    }

    function test_RevertWhen_PostingIntoFinalizedEpoch() public {
        KohakuClearingHouse.IOU[] memory ious = _loopEpoch(1, 0);
        _postAndFinalize(1, ious);
        KohakuClearingHouse.IOU[] memory late = new KohakuClearingHouse.IOU[](1);
        late[0] = _iou(4, 1, 400, 1, 1);
        bytes[] memory sigs = _signAll(late);
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.WrongEpoch.selector, uint64(2), uint64(1)));
        ch.postIous(1, late, sigs);
    }

    function test_RevertWhen_ClaimedResultInconsistent() public {
        KohakuClearingHouse.IOU[] memory ious = _loopEpoch(1, 0);
        bytes[] memory sigs = _signAll(ious);
        vm.startPrank(clearer);
        ch.postIous(1, ious, sigs);
        bytes32 ih = _iouSetHash(ious);
        // the clearer claims a different result than what the chain computed
        bytes32 wrong = keccak256("made up positions");
        vm.expectRevert();
        ch.finalizeEpoch(1, ih, wrong);
        // and a different IOU set
        (,,, bytes32 ph) = _positions(ious);
        vm.expectRevert();
        ch.finalizeEpoch(1, keccak256("other set"), ph);
        vm.stopPrank();
    }

    function test_RevertWhen_DebtorNotCovered() public {
        AgentFixture memory poor = _newAgent("poor", 100, 0); // only 100 units of collateral
        uint256 poorIdx = agents.length - 1;
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = _iou(poorIdx, 0, 5_000, 1, 1);
        bytes[] memory sigs = _signAll(one);
        vm.startPrank(clearer);
        ch.postIous(1, one, sigs);
        (,,, bytes32 ph) = _positions(one);
        bytes32 ih = _iouSetHash(one);
        vm.expectRevert(
            abi.encodeWithSelector(KohakuCollateralVault.InsufficientFree.selector, poor.id, uint256(5_000), uint256(100))
        );
        ch.finalizeEpoch(1, ih, ph);
        vm.stopPrank();
    }

    function test_EmptyEpochIsSealedWithReceipt() public {
        KohakuClearingHouse.IOU[] memory none = new KohakuClearingHouse.IOU[](0);
        _postAndFinalize(1, none);
        KohakuClearingHouse.Epoch memory e = ch.getEpoch(1);
        assertEq(uint8(e.status), uint8(KohakuClearingHouse.EpochStatus.Settled));
        assertTrue(e.receiptHash != bytes32(0));
        assertEq(ch.currentEpoch(), 2);
    }

    function test_AllAgentsNetToZero() public {
        KohakuClearingHouse.IOU[] memory ious = new KohakuClearingHouse.IOU[](2);
        ious[0] = _iou(0, 1, 500, 1, 1);
        ious[1] = _iou(1, 0, 500, 1, 1);
        _postAndFinalize(1, ious);
        KohakuClearingHouse.Epoch memory e = ch.getEpoch(1);
        assertEq(e.grossVolume, 1000);
        assertEq(e.netVolume, 0);
        assertEq(uint8(e.status), uint8(KohakuClearingHouse.EpochStatus.Settled));
    }

    function test_SingleIouHasNoCompression() public {
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = _iou(0, 1, 400, 1, 1);
        _postAndFinalize(1, one);
        KohakuClearingHouse.Epoch memory e = ch.getEpoch(1);
        assertEq(e.grossVolume, e.netVolume);
        assertEq(e.debtorCount, 1);
        assertEq(e.creditorCount, 1);
    }

    function test_DefaultSeizesCollateralAndCreditorsArePaidInFull() public {
        KohakuClearingHouse.IOU[] memory ious = _loopEpoch(1, 0);
        _postAndFinalize(1, ious);
        uint256 totalBefore = vault.accountOf(agents[0].id).total;

        vm.expectRevert();
        ch.declareDefault(1, agents[0].id); // too early

        vm.warp(block.timestamp + SETTLEMENT_WINDOW + 1);
        ch.declareDefault(1, agents[0].id); // anyone can call it
        assertEq(vault.accountOf(agents[0].id).total, totalBefore - 1200);
        assertEq(vault.accountOf(agents[0].id).locked, 0);

        uint256 b3 = usdc.balanceOf(agents[3].signer);
        ch.payout(1);
        assertEq(usdc.balanceOf(agents[3].signer) - b3, 900);
        assertEq(ch.getEpoch(1).defaultCount, 1);
        assertEq(uint8(ch.getEpoch(1).status), uint8(KohakuClearingHouse.EpochStatus.Settled));
    }

    function test_RevertWhen_SettlementRecordedWithoutPayment() public {
        _postAndFinalize(1, _loopEpoch(1, 0));
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.PaymentNotReceived.selector, uint256(1200), uint256(0)));
        ch.recordSettlement(1, agents[0].id, keccak256("p"), keccak256("t"), keccak256("r"));
    }

    function test_RevertWhen_PaymentReferenceReused() public {
        // two epochs, same debtor; the same HSP payment cannot settle both
        _postAndFinalize(1, _loopEpoch(1, 0));
        _settle(1, agents[0].id, keccak256("hsp-1"));
        ch.payout(1);
        _postAndFinalize(2, _loopEpoch(2, 100));
        vm.prank(agents[0].signer);
        usdc.transfer(address(ch), 1200);
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.RefAlreadyUsed.selector, keccak256("hsp-1")));
        ch.recordSettlement(2, agents[0].id, keccak256("hsp-1"), keccak256("t2"), keccak256("r2"));
    }

    function test_RevertWhen_PayoutWithOutstandingDebtors() public {
        _postAndFinalize(1, _loopEpoch(1, 0));
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.DebtorsOutstanding.selector, uint32(1)));
        ch.payout(1);
    }

    function test_RevertWhen_CreditorTriesToSettle() public {
        _postAndFinalize(1, _loopEpoch(1, 0));
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.NotADebtor.selector, uint64(1), agents[1].id));
        ch.recordSettlement(1, agents[1].id, keccak256("p"), keccak256("t"), keccak256("r"));
    }

    function test_HeldOutIouIsCarriedAfterRejectedDispute() public {
        KohakuClearingHouse.IOU memory disputed = _iou(4, 1, 300, 1, 1);
        bytes32 d = ch.iouDigest(disputed);
        bytes32[] memory held = new bytes32[](1);
        held[0] = d;

        vm.prank(clearer);
        ch.holdOut(1, held);

        // the held-out IOU cannot be posted into its own epoch
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = disputed;
        bytes[] memory sigs = _signAll(one);
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.IouIsHeldOut.selector, d));
        ch.postIous(1, one, sigs);

        _postAndFinalize(1, _loopEpoch(1, 0));
        assertEq(ch.heldOut(d), 1);

        // dispute rejected: the IOU stands and is carried into epoch 2, unchanged
        vm.startPrank(clearer);
        ch.postCarried(2, disputed, sigs[0]);
        (,,, bytes32 ph) = _positions(one);
        ch.finalizeEpoch(2, keccak256(abi.encode(bytes32(0), d)), ph);
        vm.stopPrank();
        assertEq(ch.getEpoch(2).carriedCount, 1);
        assertEq(ch.heldOut(d), 0);

        // and it cannot be carried twice
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.NotHeldOut.selector, d));
        ch.postCarried(3, disputed, sigs[0]);
    }

    function test_HeldOutIouIsReleasedAfterUpheldDispute() public {
        KohakuClearingHouse.IOU memory disputed = _iou(4, 1, 300, 1, 1);
        bytes32 d = ch.iouDigest(disputed);
        bytes32[] memory held = new bytes32[](1);
        held[0] = d;
        vm.startPrank(clearer);
        ch.holdOut(1, held);
        ch.releaseHeldOut(d);
        vm.stopPrank();
        assertEq(ch.heldOut(d), 0);
        _postAndFinalize(1, _loopEpoch(1, 0));
        bytes memory sig = _sign(agents[4].pk, disputed);
        vm.prank(clearer);
        vm.expectRevert(abi.encodeWithSelector(KohakuClearingHouse.NotHeldOut.selector, d));
        ch.postCarried(2, disputed, sig);
    }

    function test_CollateralBackingEpochCannotBeWithdrawn() public {
        _postAndFinalize(1, _loopEpoch(1, 0));
        AgentFixture memory a0 = agents[0];
        uint256 total = vault.accountOf(a0.id).total;
        // try to withdraw everything: only the unlocked part is available
        vm.prank(a0.operator);
        vm.expectRevert();
        vault.requestWithdrawal(a0.id, total);

        vm.prank(a0.operator);
        vault.requestWithdrawal(a0.id, total - 1200);
        vm.prank(a0.operator);
        vm.expectRevert();
        vault.withdraw(a0.id, a0.operator); // delay not elapsed

        vm.warp(block.timestamp + WITHDRAWAL_DELAY);
        vm.prank(a0.operator);
        vault.withdraw(a0.id, a0.operator);
        assertEq(vault.accountOf(a0.id).total, 1200);
        assertEq(vault.accountOf(a0.id).locked, 1200);
    }

    function test_OnlyAdminCanRotateClearer() public {
        vm.expectRevert();
        ch.setClearer(address(1));
        vm.prank(owner);
        ch.setClearer(address(1));
        assertEq(ch.clearer(), address(1));
    }

    // ------------------------------------------------------------------ fuzz

    /// Random IOU sets among five agents: net positions always sum to zero, every creditor is
    /// paid exactly its net, every debtor pays exactly its net, and the pool ends empty.
    function testFuzz_NettingConservesValue(uint256 seed, uint8 count) public {
        uint256 n = bound(count, 1, 40);
        KohakuClearingHouse.IOU[] memory ious = new KohakuClearingHouse.IOU[](n);
        // generate sorted by buyer then nonce: buyers in ascending index order
        uint64[5] memory nonces;
        uint256 idx;
        for (uint256 b = 0; b < 5 && idx < n; b++) {
            uint256 take = (b == 4) ? n - idx : bound(uint256(keccak256(abi.encode(seed, "take", b))), 0, n - idx);
            for (uint256 k = 0; k < take; k++) {
                uint256 r = uint256(keccak256(abi.encode(seed, b, k)));
                uint256 s = (b + 1 + (r % 4)) % 5; // never the buyer itself
                uint256 amt = 1 + (r >> 8) % 50_000;
                nonces[b] += 1 + uint64((r >> 40) % 3);
                ious[idx++] = _iou(b, s, amt, 1, nonces[b]);
            }
        }
        _postAndFinalize(1, ious);

        (uint256[] memory ids, uint256[] memory credit, uint256[] memory debit,) = _positions(ious);
        int256 sum;
        uint256[] memory before = new uint256[](ids.length);
        for (uint256 k = 0; k < ids.length; k++) {
            (,, int256 net,) = ch.getPosition(1, ids[k]);
            assertEq(net, int256(credit[k]) - int256(debit[k]));
            sum += net;
            before[k] = usdc.balanceOf(_signerOf(ids[k]));
        }
        assertEq(sum, 0);

        for (uint256 k = 0; k < ids.length; k++) {
            if (debit[k] > credit[k]) _settle(1, ids[k], keccak256(abi.encode("pay", k)));
        }
        if (ch.getEpoch(1).status == KohakuClearingHouse.EpochStatus.Finalized) ch.payout(1);

        for (uint256 k = 0; k < ids.length; k++) {
            int256 delta = int256(usdc.balanceOf(_signerOf(ids[k]))) - int256(before[k]);
            assertEq(delta, int256(credit[k]) - int256(debit[k]));
        }
        assertEq(ch.accountedBalance(), 0);
        assertEq(usdc.balanceOf(address(ch)), 0);
    }

    /// Any single-field tampering of a signed IOU is rejected.
    function testFuzz_TamperedIouRejected(uint256 amount, uint8 field) public {
        amount = bound(amount, 1, 1e9);
        KohakuClearingHouse.IOU[] memory one = new KohakuClearingHouse.IOU[](1);
        one[0] = _iou(0, 1, amount, 1, 5);
        bytes[] memory sigs = _signAll(one);
        uint256 f = field % 4;
        if (f == 0) one[0].amount = amount + 1;
        else if (f == 1) one[0].seller = agents[2].id;
        else if (f == 2) one[0].jobHash = keccak256("other job");
        else one[0].nonce = 6;
        vm.prank(clearer);
        vm.expectRevert();
        ch.postIous(1, one, sigs);
    }
}
