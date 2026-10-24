// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {KohakuIdentityRegistry} from "./KohakuIdentityRegistry.sol";

/// @title KohakuCollateralVault
/// @notice Holds the stablecoin collateral that backs every agent's IOUs.
///
/// Rules:
///  - Anyone may deposit for a registered agent.
///  - Only the operator may withdraw, in two steps. A request starts a delay that is longer
///    than an epoch's full lifetime, so any IOU signed before the request is netted and its
///    debt locked before the money can leave.
///  - The clearing house locks a debtor's net debit when an epoch is finalised, unlocks it
///    when the debtor settles through HSP, and seizes it if the debtor defaults.
///  - Locked collateral can never be withdrawn.
contract KohakuCollateralVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Account {
        uint256 total;
        uint256 locked;
        uint256 pendingWithdrawal;
        uint64 unlockAt;
    }

    IERC20 public immutable token;
    KohakuIdentityRegistry public immutable identity;
    address public immutable deployer;
    address public clearingHouse;
    uint64 public immutable withdrawalDelay;

    mapping(uint256 agentId => Account) private _accounts;

    event Deposited(uint256 indexed agentId, address indexed from, uint256 amount, uint256 total);
    event WithdrawalRequested(uint256 indexed agentId, uint256 amount, uint64 unlockAt);
    event WithdrawalCancelled(uint256 indexed agentId);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event Locked(uint256 indexed agentId, uint256 amount, uint256 locked);
    event Unlocked(uint256 indexed agentId, uint256 amount, uint256 locked);
    event Seized(uint256 indexed agentId, uint256 amount, address indexed to);
    event ClearingHouseSet(address indexed clearingHouse);

    error NotOperator(uint256 agentId, address caller);
    error NotClearingHouse(address caller);
    error AlreadyInitialised();
    error UnknownAgent(uint256 agentId);
    error ZeroAmount();
    error InsufficientFree(uint256 agentId, uint256 requested, uint256 free);
    error NothingPending(uint256 agentId);
    error StillLocked(uint64 unlockAt);
    error InsufficientLocked(uint256 agentId, uint256 requested, uint256 locked);

    constructor(IERC20 token_, KohakuIdentityRegistry identity_, uint64 withdrawalDelay_) {
        token = token_;
        identity = identity_;
        withdrawalDelay = withdrawalDelay_;
        deployer = msg.sender;
    }

    /// @notice One-time wiring of the clearing house (it is deployed after the vault).
    function setClearingHouse(address clearingHouse_) external {
        if (msg.sender != deployer || clearingHouse != address(0)) revert AlreadyInitialised();
        clearingHouse = clearingHouse_;
        emit ClearingHouseSet(clearingHouse_);
    }

    modifier onlyClearingHouse() {
        if (msg.sender != clearingHouse) revert NotClearingHouse(msg.sender);
        _;
    }

    modifier onlyOperator(uint256 agentId) {
        if (identity.operatorOf(agentId) != msg.sender) revert NotOperator(agentId, msg.sender);
        _;
    }

    // ---------------------------------------------------------------- operator / public

    function deposit(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!identity.exists(agentId)) revert UnknownAgent(agentId);
        token.safeTransferFrom(msg.sender, address(this), amount);
        Account storage a = _accounts[agentId];
        a.total += amount;
        emit Deposited(agentId, msg.sender, amount, a.total);
    }

    function requestWithdrawal(uint256 agentId, uint256 amount) external onlyOperator(agentId) {
        if (amount == 0) revert ZeroAmount();
        uint256 free = available(agentId);
        if (amount > free) revert InsufficientFree(agentId, amount, free);
        Account storage a = _accounts[agentId];
        a.pendingWithdrawal += amount;
        a.unlockAt = uint64(block.timestamp) + withdrawalDelay;
        emit WithdrawalRequested(agentId, a.pendingWithdrawal, a.unlockAt);
    }

    function cancelWithdrawal(uint256 agentId) external onlyOperator(agentId) {
        Account storage a = _accounts[agentId];
        if (a.pendingWithdrawal == 0) revert NothingPending(agentId);
        a.pendingWithdrawal = 0;
        a.unlockAt = 0;
        emit WithdrawalCancelled(agentId);
    }

    /// @notice Complete a withdrawal after the delay. Pays out the pending amount, capped at
    /// whatever is not locked behind a finalised epoch at that moment.
    function withdraw(uint256 agentId, address to) external nonReentrant onlyOperator(agentId) {
        Account storage a = _accounts[agentId];
        if (a.pendingWithdrawal == 0) revert NothingPending(agentId);
        if (block.timestamp < a.unlockAt) revert StillLocked(a.unlockAt);
        uint256 unlockedTotal = a.total - a.locked;
        uint256 amount = a.pendingWithdrawal <= unlockedTotal ? a.pendingWithdrawal : unlockedTotal;
        if (amount == 0) revert InsufficientFree(agentId, a.pendingWithdrawal, 0);
        a.pendingWithdrawal = 0;
        a.unlockAt = 0;
        a.total -= amount;
        token.safeTransfer(to, amount);
        emit Withdrawn(agentId, to, amount);
    }

    // ---------------------------------------------------------------- clearing house

    function lock(uint256 agentId, uint256 amount) external onlyClearingHouse {
        Account storage a = _accounts[agentId];
        uint256 unlockedTotal = a.total - a.locked;
        if (amount > unlockedTotal) revert InsufficientFree(agentId, amount, unlockedTotal);
        a.locked += amount;
        emit Locked(agentId, amount, a.locked);
    }

    function unlock(uint256 agentId, uint256 amount) external onlyClearingHouse {
        Account storage a = _accounts[agentId];
        if (amount > a.locked) revert InsufficientLocked(agentId, amount, a.locked);
        a.locked -= amount;
        emit Unlocked(agentId, amount, a.locked);
    }

    function seize(uint256 agentId, uint256 amount, address to) external nonReentrant onlyClearingHouse {
        Account storage a = _accounts[agentId];
        if (amount > a.locked) revert InsufficientLocked(agentId, amount, a.locked);
        a.locked -= amount;
        a.total -= amount;
        token.safeTransfer(to, amount);
        emit Seized(agentId, amount, to);
    }

    // ---------------------------------------------------------------- views

    function accountOf(uint256 agentId) external view returns (Account memory) {
        return _accounts[agentId];
    }

    /// @notice Collateral that can back new IOUs: total minus locked minus pending withdrawal.
    function available(uint256 agentId) public view returns (uint256) {
        Account storage a = _accounts[agentId];
        uint256 reserved = a.locked + a.pendingWithdrawal;
        return a.total > reserved ? a.total - reserved : 0;
    }
}
