// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockUSDC
/// @notice 6-decimal test stablecoin for local development only. It is never deployed to a
/// public network by the Kohaku scripts; on HashKey Chain Kohaku settles in the real
/// stablecoin configured for the deployment.
contract MockUSDC is ERC20, ERC20Permit {
    uint256 public constant FAUCET_CAP = 10_000e6;

    constructor() ERC20("Mock USD Coin", "mUSDC") ERC20Permit("Mock USD Coin") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet for local testing, capped per call.
    function mint(address to, uint256 amount) external {
        require(amount <= FAUCET_CAP, "MockUSDC: over faucet cap");
        _mint(to, amount);
    }
}
