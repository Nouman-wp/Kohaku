// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {KohakuBase} from "./KohakuBase.t.sol";
import {KohakuClearingHouse} from "../src/KohakuClearingHouse.sol";

/// Writes cross-language test vectors so the TypeScript netting and EIP-712 code can be
/// checked against the contract bit for bit (packages/core/test/parity.test.ts).
contract VectorsTest is KohakuBase {
    function test_WriteParityVectors() public {
        KohakuClearingHouse.IOU[] memory ious = new KohakuClearingHouse.IOU[](5);
        ious[0] = _iou(0, 1, 400, 1, 3);
        ious[1] = _iou(0, 2, 1500, 1, 9);
        ious[2] = _iou(1, 2, 700, 1, 1);
        ious[3] = _iou(2, 0, 2500, 1, 4);
        ious[4] = _iou(3, 1, 999, 1, 2);
        _postAndFinalize(1, ious);

        KohakuClearingHouse.Epoch memory e = ch.getEpoch(1);
        string memory root = "root";
        string memory arr = "";
        for (uint256 i = 0; i < ious.length; i++) {
            string memory k = string.concat("iou", vm.toString(i));
            vm.serializeUint(k, "buyer", ious[i].buyer);
            vm.serializeUint(k, "seller", ious[i].seller);
            vm.serializeUint(k, "amount", ious[i].amount);
            vm.serializeAddress(k, "token", ious[i].token);
            vm.serializeBytes32(k, "jobHash", ious[i].jobHash);
            vm.serializeBytes32(k, "quoteHash", ious[i].quoteHash);
            vm.serializeUint(k, "epoch", ious[i].epoch);
            vm.serializeUint(k, "nonce", ious[i].nonce);
            vm.serializeBytes(k, "signature", _sign(_pkOf(ious[i].buyer), ious[i]));
            string memory obj = vm.serializeBytes32(k, "digest", ch.iouDigest(ious[i]));
            arr = i == 0 ? obj : string.concat(arr, ",", obj);
        }
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "clearingHouse", address(ch));
        vm.serializeBytes32(root, "domainSeparator", ch.domainSeparator());
        vm.serializeBytes32(root, "iouSetHash", e.iouSetHash);
        vm.serializeBytes32(root, "positionsHash", e.positionsHash);
        vm.serializeUint(root, "grossVolume", e.grossVolume);
        vm.serializeUint(root, "netVolume", e.netVolume);
        string memory json = vm.serializeString(root, "iousJson", string.concat("[", arr, "]"));
        vm.writeJson(json, string.concat(vm.projectRoot(), "/../packages/core/test/vectors.json"));
    }
}
