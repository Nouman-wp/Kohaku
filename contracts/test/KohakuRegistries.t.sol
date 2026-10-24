// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {KohakuBase} from "./KohakuBase.t.sol";
import {KohakuIdentityRegistry} from "../src/KohakuIdentityRegistry.sol";
import {KohakuReputationRegistry} from "../src/KohakuReputationRegistry.sol";
import {KohakuValidationRegistry} from "../src/KohakuValidationRegistry.sol";

contract KohakuRegistriesTest is KohakuBase {
    // ------------------------------------------------------------------ identity

    function test_RegisterRecordsOperatorSignerAndCard() public view {
        AgentFixture memory a = agents[0];
        assertEq(identity.ownerOf(a.id), a.operator);
        assertEq(identity.signerOf(a.id), a.signer);
        assertEq(identity.agentIdOfSigner(a.signer), a.id);
        assertEq(identity.tokenURI(a.id), "https://kohaku.test/agents/agent-0.json");
        assertTrue(identity.isActive(a.id));
    }

    function test_SignerCannotBeShared() public {
        address op = makeAddr("op2");
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(KohakuIdentityRegistry.SignerTaken.selector, agents[0].signer, agents[0].id));
        identity.register("x", agents[0].signer, new KohakuIdentityRegistry.MetadataEntry[](0));
    }

    function test_OperatorLifecycle() public {
        AgentFixture memory a = agents[1];
        vm.startPrank(a.operator);
        identity.setAgentURI(a.id, "ipfs://card-v2");
        identity.setMetadata(a.id, "services", abi.encode("search", uint256(400)));
        identity.pause(a.id);
        assertEq(uint8(identity.statusOf(a.id)), uint8(KohakuIdentityRegistry.Status.Paused));
        identity.unpause(a.id);
        identity.retire(a.id);
        vm.expectRevert(abi.encodeWithSelector(KohakuIdentityRegistry.AgentRetired.selector, a.id));
        identity.retire(a.id);
        vm.expectRevert();
        identity.unpause(a.id);
        vm.stopPrank();
        assertEq(identity.tokenURI(a.id), "ipfs://card-v2");
        (string memory svc, uint256 price) = abi.decode(identity.getMetadata(a.id, "services"), (string, uint256));
        assertEq(svc, "search");
        assertEq(price, 400);
    }

    function test_OnlyOperatorCanEdit() public {
        vm.expectRevert(abi.encodeWithSelector(KohakuIdentityRegistry.NotOperator.selector, agents[0].id, address(this)));
        identity.pause(agents[0].id);
    }

    function test_SignerRotationMovesPayoutAddress() public {
        AgentFixture memory a = agents[2];
        address newSigner = makeAddr("rotated");
        vm.prank(a.operator);
        identity.setSigner(a.id, newSigner);
        assertEq(identity.signerOf(a.id), newSigner);
        assertEq(identity.agentIdOfSigner(a.signer), 0);
        assertEq(identity.agentIdOfSigner(newSigner), a.id);
    }

    // ------------------------------------------------------------------ reputation

    function test_FeedbackAndSummary() public {
        address client = makeAddr("client");
        vm.prank(client);
        reputation.giveFeedback(agents[0].id, 80, 0, "quality", "", "", "", bytes32(0));
        vm.prank(client);
        reputation.giveFeedback(agents[0].id, 60, 0, "quality", "", "", "", bytes32(0));
        address[] memory none = new address[](0);
        (uint64 count, int128 value, uint8 decimals) = reputation.getSummary(agents[0].id, none, "quality", "");
        assertEq(count, 2);
        assertEq(decimals, 18);
        assertEq(value, 70e18);
        vm.prank(client);
        reputation.revokeFeedback(agents[0].id, 1);
        (count, value,) = reputation.getSummary(agents[0].id, none, "quality", "");
        assertEq(count, 1);
        assertEq(value, 80e18);
    }

    function test_NoSelfFeedback() public {
        vm.prank(agents[0].operator);
        vm.expectRevert(abi.encodeWithSelector(KohakuReputationRegistry.SelfFeedback.selector, agents[0].id));
        reputation.giveFeedback(agents[0].id, 100, 0, "", "", "", "", bytes32(0));
    }

    function test_EpochScores() public {
        uint256[] memory ids = new uint256[](2);
        int128[] memory scores = new int128[](2);
        ids[0] = agents[0].id;
        ids[1] = agents[1].id;
        scores[0] = 812;
        scores[1] = 455;
        vm.prank(clearer);
        reputation.recordEpochScores(3, ids, scores, keccak256("inputs"), "https://kohaku.test/epochs/3/reputation");
        assertEq(reputation.latestScore(agents[0].id), 812);
        assertEq(reputation.latestScoreEpoch(agents[1].id), 3);
        // cannot rewrite an epoch or go backwards
        vm.prank(clearer);
        vm.expectRevert();
        reputation.recordEpochScores(3, ids, scores, bytes32(0), "");
        // only the scorer
        vm.expectRevert();
        reputation.recordEpochScores(4, ids, scores, bytes32(0), "");
        // range checked
        scores[0] = 1001;
        vm.prank(clearer);
        vm.expectRevert();
        reputation.recordEpochScores(4, ids, scores, bytes32(0), "");
    }

    // ------------------------------------------------------------------ validation

    function test_DisputeValidationRoundTrip() public {
        AgentFixture memory arbiter = agents[4];
        usdc.mint(arbiter.signer, 10e6);
        vm.startPrank(arbiter.signer);
        usdc.approve(address(validation), 10e6);
        validation.stake(10e6);
        vm.stopPrank();

        bytes32 req = keccak256("dispute-1");
        vm.prank(clearer);
        validation.validationRequest(arbiter.signer, agents[1].id, "https://kohaku.test/disputes/1", req);

        vm.prank(makeAddr("random"));
        vm.expectRevert();
        validation.validationResponse(req, 0, "", bytes32(0), "upheld");

        vm.prank(arbiter.signer);
        validation.validationResponse(req, 0, "https://kohaku.test/disputes/1/verdict", keccak256("verdict"), "upheld");
        (address v, uint256 agentId, uint8 resp,,,) = validation.getValidationStatus(req);
        assertEq(v, arbiter.signer);
        assertEq(agentId, agents[1].id);
        assertEq(resp, 0);

        vm.prank(arbiter.signer);
        vm.expectRevert(abi.encodeWithSelector(KohakuValidationRegistry.AlreadyResponded.selector, req));
        validation.validationResponse(req, 100, "", bytes32(0), "");
    }

    function test_UnstakedValidatorCannotRule() public {
        bytes32 req = keccak256("dispute-2");
        validation.validationRequest(agents[3].signer, agents[1].id, "", req);
        vm.prank(agents[3].signer);
        vm.expectRevert(
            abi.encodeWithSelector(KohakuValidationRegistry.InsufficientStake.selector, agents[3].signer, 0, 5e6)
        );
        validation.validationResponse(req, 100, "", bytes32(0), "");
    }

    function test_SlashAndUnstakeDelay() public {
        address val = agents[3].signer;
        usdc.mint(val, 8e6);
        vm.startPrank(val);
        usdc.approve(address(validation), 8e6);
        validation.stake(8e6);
        validation.requestUnstake(3e6);
        vm.expectRevert();
        validation.unstake();
        vm.stopPrank();

        vm.prank(owner);
        validation.slash(val, 6e6, owner, keccak256("overturned"));
        (uint256 active, uint256 pending,) = validation.stakes(val);
        assertEq(active, 0);
        assertEq(pending, 2e6);

        vm.warp(block.timestamp + 601);
        vm.prank(val);
        validation.unstake();
        assertEq(usdc.balanceOf(owner), 6e6);
    }
}
