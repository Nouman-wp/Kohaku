// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC internal usdc;
    uint256 internal payerKey = 0xA11CE;
    address internal payer;
    address internal pool = address(0xB0B);
    address internal relayer = address(0xFEE);

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        payer = vm.addr(payerKey);
        usdc.mint(payer, 100e6);
    }

    function _sign(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, to, value, validAfter, validBefore, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_relayedTransferMovesExactAmountAndBurnsNonce() public {
        bytes32 nonce = keccak256("kohaku.settlement.v1/epoch-7/agent-3");
        bytes memory sig = _sign(pool, 12_345, block.timestamp - 1, block.timestamp + 300, nonce);
        vm.prank(relayer);
        vm.expectEmit(true, true, false, false);
        emit MockUSDC.AuthorizationUsed(payer, nonce);
        usdc.transferWithAuthorization(payer, pool, 12_345, block.timestamp - 1, block.timestamp + 300, nonce, sig);
        assertEq(usdc.balanceOf(pool), 12_345);
        assertEq(usdc.balanceOf(payer), 100e6 - 12_345);
        assertTrue(usdc.authorizationState(payer, nonce));

        vm.expectRevert(MockUSDC.AuthorizationAlreadyUsed.selector);
        usdc.transferWithAuthorization(payer, pool, 12_345, block.timestamp - 1, block.timestamp + 300, nonce, sig);
    }

    function test_rejectsTamperedAmountOrPayee() public {
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig = _sign(pool, 1e6, block.timestamp - 1, block.timestamp + 300, nonce);
        vm.expectRevert(MockUSDC.InvalidAuthorizationSignature.selector);
        usdc.transferWithAuthorization(payer, pool, 2e6, block.timestamp - 1, block.timestamp + 300, nonce, sig);
        vm.expectRevert(MockUSDC.InvalidAuthorizationSignature.selector);
        usdc.transferWithAuthorization(payer, relayer, 1e6, block.timestamp - 1, block.timestamp + 300, nonce, sig);
    }

    function test_respectsValidityWindow() public {
        bytes32 nonce = bytes32(uint256(2));
        bytes memory early = _sign(pool, 1e6, block.timestamp + 10, block.timestamp + 300, nonce);
        vm.expectRevert(MockUSDC.AuthorizationNotYetValid.selector);
        usdc.transferWithAuthorization(payer, pool, 1e6, block.timestamp + 10, block.timestamp + 300, nonce, early);

        bytes memory late = _sign(pool, 1e6, block.timestamp - 100, block.timestamp - 1, nonce);
        vm.expectRevert(MockUSDC.AuthorizationExpired.selector);
        usdc.transferWithAuthorization(payer, pool, 1e6, block.timestamp - 100, block.timestamp - 1, nonce, late);
    }

    function test_vrsOverload() public {
        bytes32 nonce = bytes32(uint256(3));
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, pool, 5e5, block.timestamp - 1, block.timestamp + 60, nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        usdc.transferWithAuthorization(payer, pool, 5e5, block.timestamp - 1, block.timestamp + 60, nonce, v, r, s);
        assertEq(usdc.balanceOf(pool), 5e5);
    }

    function test_mintIsCapped() public {
        vm.expectRevert("MockUSDC: over faucet cap");
        usdc.mint(payer, 10_001e6);
    }
}
