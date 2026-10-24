// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {KohakuIdentityRegistry} from "../src/KohakuIdentityRegistry.sol";
import {KohakuCollateralVault} from "../src/KohakuCollateralVault.sol";
import {KohakuClearingHouse} from "../src/KohakuClearingHouse.sol";
import {KohakuReputationRegistry} from "../src/KohakuReputationRegistry.sol";
import {KohakuValidationRegistry} from "../src/KohakuValidationRegistry.sol";

/// Deploys the full Kohaku suite and writes the addresses to deployments/<chainId>.json.
///
/// Environment:
///   DEPLOYER_PRIVATE_KEY   key that pays for deployment (becomes owner unless OWNER_ADDRESS is set)
///   SETTLEMENT_TOKEN       stablecoin address; leave empty to deploy MockUSDC (local / test only)
///   CLEARER_ADDRESS        the clearing service's key (posts epochs, records HSP payments)
///   OWNER_ADDRESS          admin for the few admin-only functions (defaults to deployer)
///   SETTLEMENT_WINDOW      seconds debtors have to settle after finalisation (default 120)
///   WITHDRAWAL_DELAY       seconds between a withdrawal request and its execution (default 600)
///   MIN_VALIDATOR_STAKE    base units a validator must stake (default 5 USDC)
contract Deploy is Script {
    struct Config {
        uint256 pk;
        address deployer;
        address owner;
        address clearer;
        address token;
        uint64 settlementWindow;
        uint64 withdrawalDelay;
        uint256 minStake;
    }

    struct Deployed {
        bool mockToken;
        address token;
        address identity;
        address vault;
        address clearingHouse;
        address reputation;
        address validation;
    }

    function run() external {
        Config memory c = _config();
        vm.startBroadcast(c.pk);
        Deployed memory d = _deploy(c);
        vm.stopBroadcast();
        _write(c, d);
    }

    function _config() internal view returns (Config memory c) {
        c.pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        c.deployer = vm.addr(c.pk);
        c.owner = vm.envOr("OWNER_ADDRESS", c.deployer);
        c.clearer = vm.envOr("CLEARER_ADDRESS", c.deployer);
        c.token = vm.envOr("SETTLEMENT_TOKEN", address(0));
        c.settlementWindow = uint64(vm.envOr("SETTLEMENT_WINDOW", uint256(120)));
        c.withdrawalDelay = uint64(vm.envOr("WITHDRAWAL_DELAY", uint256(600)));
        c.minStake = vm.envOr("MIN_VALIDATOR_STAKE", uint256(5e6));
    }

    function _deploy(Config memory c) internal returns (Deployed memory d) {
        d.mockToken = c.token == address(0);
        d.token = d.mockToken ? address(new MockUSDC()) : c.token;
        KohakuIdentityRegistry identity = new KohakuIdentityRegistry();
        KohakuCollateralVault vault = new KohakuCollateralVault(IERC20(d.token), identity, c.withdrawalDelay);
        KohakuClearingHouse ch =
            new KohakuClearingHouse(identity, vault, IERC20(d.token), c.clearer, c.settlementWindow, c.owner);
        vault.setClearingHouse(address(ch));
        d.identity = address(identity);
        d.vault = address(vault);
        d.clearingHouse = address(ch);
        d.reputation = address(new KohakuReputationRegistry(identity, c.clearer, c.owner));
        d.validation = address(new KohakuValidationRegistry(identity, IERC20(d.token), c.minStake, 600, c.owner));
    }

    function _write(Config memory c, Deployed memory d) internal {
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "deployedAtBlock", block.number);
        vm.serializeAddress(key, "deployer", c.deployer);
        vm.serializeAddress(key, "owner", c.owner);
        vm.serializeAddress(key, "clearer", c.clearer);
        vm.serializeBool(key, "mockToken", d.mockToken);
        vm.serializeAddress(key, "token", d.token);
        vm.serializeAddress(key, "identityRegistry", d.identity);
        vm.serializeAddress(key, "collateralVault", d.vault);
        vm.serializeAddress(key, "clearingHouse", d.clearingHouse);
        vm.serializeAddress(key, "reputationRegistry", d.reputation);
        vm.serializeUint(key, "settlementWindow", c.settlementWindow);
        vm.serializeUint(key, "withdrawalDelay", c.withdrawalDelay);
        string memory json = vm.serializeAddress(key, "validationRegistry", d.validation);
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console2.log("token              ", d.token);
        console2.log("identityRegistry   ", d.identity);
        console2.log("collateralVault    ", d.vault);
        console2.log("clearingHouse      ", d.clearingHouse);
        console2.log("reputationRegistry ", d.reputation);
        console2.log("validationRegistry ", d.validation);
        console2.log("written to         ", path);
    }
}
