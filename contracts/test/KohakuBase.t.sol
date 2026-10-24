// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {KohakuIdentityRegistry} from "../src/KohakuIdentityRegistry.sol";
import {KohakuCollateralVault} from "../src/KohakuCollateralVault.sol";
import {KohakuClearingHouse} from "../src/KohakuClearingHouse.sol";
import {KohakuReputationRegistry} from "../src/KohakuReputationRegistry.sol";
import {KohakuValidationRegistry} from "../src/KohakuValidationRegistry.sol";

/// Shared fixture: a full Kohaku deployment plus a handful of funded agents.
abstract contract KohakuBase is Test {
    MockUSDC internal usdc;
    KohakuIdentityRegistry internal identity;
    KohakuCollateralVault internal vault;
    KohakuClearingHouse internal ch;
    KohakuReputationRegistry internal reputation;
    KohakuValidationRegistry internal validation;

    address internal owner = makeAddr("owner");
    address internal clearer = makeAddr("clearer");

    uint64 internal constant WITHDRAWAL_DELAY = 600;
    uint64 internal constant SETTLEMENT_WINDOW = 120;

    struct AgentFixture {
        uint256 id;
        uint256 pk;
        address signer;
        address operator;
    }

    AgentFixture[] internal agents;

    function setUp() public virtual {
        usdc = new MockUSDC();
        identity = new KohakuIdentityRegistry();
        vault = new KohakuCollateralVault(usdc, identity, WITHDRAWAL_DELAY);
        ch = new KohakuClearingHouse(identity, vault, usdc, clearer, SETTLEMENT_WINDOW, owner);
        vault.setClearingHouse(address(ch));
        reputation = new KohakuReputationRegistry(identity, clearer, owner);
        validation = new KohakuValidationRegistry(identity, usdc, 5e6, 600, owner);
        for (uint256 i = 0; i < 5; i++) {
            _newAgent(string.concat("agent-", vm.toString(i)), 1_000e6, 100e6);
        }
    }

    function _newAgent(string memory name, uint256 collateral, uint256 walletFunds)
        internal
        returns (AgentFixture memory a)
    {
        (address signer, uint256 pk) = makeAddrAndKey(string.concat(name, "-signer"));
        address operator = makeAddr(string.concat(name, "-operator"));
        vm.prank(operator);
        uint256 id = identity.register(
            string.concat("https://kohaku.test/agents/", name, ".json"),
            signer,
            new KohakuIdentityRegistry.MetadataEntry[](0)
        );
        if (collateral > 0) {
            usdc.mint(operator, collateral);
            vm.startPrank(operator);
            usdc.approve(address(vault), collateral);
            vault.deposit(id, collateral);
            vm.stopPrank();
        }
        if (walletFunds > 0) usdc.mint(signer, walletFunds);
        a = AgentFixture({id: id, pk: pk, signer: signer, operator: operator});
        agents.push(a);
    }

    function _iou(uint256 buyerIdx, uint256 sellerIdx, uint256 amount, uint64 epoch, uint64 nonce)
        internal
        view
        returns (KohakuClearingHouse.IOU memory)
    {
        return KohakuClearingHouse.IOU({
            buyer: agents[buyerIdx].id,
            seller: agents[sellerIdx].id,
            amount: amount,
            token: address(usdc),
            jobHash: keccak256(abi.encode("job", buyerIdx, sellerIdx, nonce)),
            quoteHash: keccak256(abi.encode("quote", buyerIdx, sellerIdx, nonce)),
            epoch: epoch,
            nonce: nonce
        });
    }

    function _sign(uint256 pk, KohakuClearingHouse.IOU memory iou) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ch.iouDigest(iou));
        return abi.encodePacked(r, s, v);
    }

    function _signAll(KohakuClearingHouse.IOU[] memory ious) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](ious.length);
        for (uint256 i = 0; i < ious.length; i++) {
            sigs[i] = _sign(_pkOf(ious[i].buyer), ious[i]);
        }
    }

    function _pkOf(uint256 agentId) internal view returns (uint256) {
        for (uint256 i = 0; i < agents.length; i++) {
            if (agents[i].id == agentId) return agents[i].pk;
        }
        revert("unknown agent");
    }

    function _signerOf(uint256 agentId) internal view returns (address) {
        return identity.signerOf(agentId);
    }

    /// Reference implementation of the IOU-set commitment (posting order).
    function _iouSetHash(KohakuClearingHouse.IOU[] memory ious) internal view returns (bytes32 h) {
        for (uint256 i = 0; i < ious.length; i++) {
            h = keccak256(abi.encode(h, ch.iouDigest(ious[i])));
        }
    }

    /// Reference implementation of netting + the positions commitment. Participants are
    /// ordered by first appearance (buyer before seller) in posting order.
    function _positions(KohakuClearingHouse.IOU[] memory ious)
        internal
        pure
        returns (uint256[] memory ids, uint256[] memory credit, uint256[] memory debit, bytes32 h)
    {
        uint256[] memory tmpIds = new uint256[](ious.length * 2);
        uint256 n;
        for (uint256 i = 0; i < ious.length; i++) {
            n = _addOnce(tmpIds, n, ious[i].buyer);
            n = _addOnce(tmpIds, n, ious[i].seller);
        }
        ids = new uint256[](n);
        credit = new uint256[](n);
        debit = new uint256[](n);
        for (uint256 k = 0; k < n; k++) ids[k] = tmpIds[k];
        for (uint256 i = 0; i < ious.length; i++) {
            for (uint256 k = 0; k < n; k++) {
                if (ids[k] == ious[i].buyer) debit[k] += ious[i].amount;
                if (ids[k] == ious[i].seller) credit[k] += ious[i].amount;
            }
        }
        for (uint256 k = 0; k < n; k++) {
            h = keccak256(abi.encode(h, ids[k], uint128(credit[k]), uint128(debit[k])));
        }
    }

    function _addOnce(uint256[] memory arr, uint256 n, uint256 v) private pure returns (uint256) {
        for (uint256 k = 0; k < n; k++) {
            if (arr[k] == v) return n;
        }
        arr[n] = v;
        return n + 1;
    }

    /// Post a full epoch in one chunk and finalise it with the reference commitments.
    function _postAndFinalize(uint64 epochId, KohakuClearingHouse.IOU[] memory ious) internal {
        bytes[] memory sigs = _signAll(ious);
        vm.startPrank(clearer);
        if (ious.length > 0) ch.postIous(epochId, ious, sigs);
        (,,, bytes32 ph) = _positions(ious);
        ch.finalizeEpoch(epochId, _iouSetHash(ious), ph);
        vm.stopPrank();
    }

    /// A debtor settles: its own wallet transfers the exact debt to the pool (the HSP
    /// evm-transfer path), then the clearer records the verified HSP payment.
    function _settle(uint64 epochId, uint256 agentId, bytes32 paymentId) internal {
        (,, int256 net,) = ch.getPosition(epochId, agentId);
        uint256 owed = uint256(-net);
        vm.prank(_signerOf(agentId));
        usdc.transfer(address(ch), owed);
        vm.prank(clearer);
        ch.recordSettlement(epochId, agentId, paymentId, keccak256(abi.encode("tx", paymentId)), keccak256(abi.encode("rcpt", paymentId)));
    }
}
