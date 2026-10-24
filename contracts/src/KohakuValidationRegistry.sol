// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {KohakuIdentityRegistry} from "./KohakuIdentityRegistry.sol";

/// @title KohakuValidationRegistry
/// @notice ERC-8004 style validation registry used for Kohaku disputes. A disputed job
/// becomes a validation request addressed to a staked validator agent; the validator's
/// verdict is written back as a response (0 = the seller's work failed, 100 = it passed).
/// Validators lock stablecoin stake to participate. Stake can be slashed by the owner when
/// a verdict is overturned on appeal; that is the only admin power and it is evented.
contract KohakuValidationRegistry is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Request {
        address validator;
        uint256 agentId; // the agent whose work is being validated (the seller)
        address requester;
        uint8 response;
        bool responded;
        bytes32 responseHash;
        string tag;
        uint64 lastUpdate;
    }

    struct Stake {
        uint256 amount;
        uint256 pendingUnstake;
        uint64 unlockAt;
    }

    KohakuIdentityRegistry public immutable identity;
    IERC20 public immutable stakeToken;
    uint256 public minStake;
    uint64 public unstakeDelay;

    mapping(bytes32 requestHash => Request) private _requests;
    mapping(address validator => Stake) public stakes;
    mapping(uint256 agentId => bytes32[]) private _agentRequests;
    mapping(address validator => bytes32[]) private _validatorRequests;

    event ValidationRequest(
        address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash
    );
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );
    event Staked(address indexed validator, uint256 amount, uint256 total);
    event UnstakeRequested(address indexed validator, uint256 amount, uint64 unlockAt);
    event Unstaked(address indexed validator, uint256 amount);
    event Slashed(address indexed validator, uint256 amount, address indexed to, bytes32 indexed requestHash);
    event ParamsChanged(uint256 minStake, uint64 unstakeDelay);

    error RequestExists(bytes32 requestHash);
    error UnknownRequest(bytes32 requestHash);
    error NotValidator(address caller);
    error AlreadyResponded(bytes32 requestHash);
    error ResponseOutOfRange(uint8 response);
    error InsufficientStake(address validator, uint256 staked, uint256 required);
    error NothingToUnstake();
    error StillLocked(uint64 unlockAt);
    error UnknownAgent(uint256 agentId);

    constructor(KohakuIdentityRegistry identity_, IERC20 stakeToken_, uint256 minStake_, uint64 unstakeDelay_, address owner_)
        Ownable(owner_)
    {
        identity = identity_;
        stakeToken = stakeToken_;
        minStake = minStake_;
        unstakeDelay = unstakeDelay_;
        emit ParamsChanged(minStake_, unstakeDelay_);
    }

    function setParams(uint256 minStake_, uint64 unstakeDelay_) external onlyOwner {
        minStake = minStake_;
        unstakeDelay = unstakeDelay_;
        emit ParamsChanged(minStake_, unstakeDelay_);
    }

    // ---------------------------------------------------------------- staking

    function stake(uint256 amount) external nonReentrant {
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        stakes[msg.sender].amount += amount;
        emit Staked(msg.sender, amount, stakes[msg.sender].amount);
    }

    function requestUnstake(uint256 amount) external {
        Stake storage s = stakes[msg.sender];
        if (amount == 0 || amount > s.amount) revert NothingToUnstake();
        s.amount -= amount;
        s.pendingUnstake += amount;
        s.unlockAt = uint64(block.timestamp) + unstakeDelay;
        emit UnstakeRequested(msg.sender, amount, s.unlockAt);
    }

    function unstake() external nonReentrant {
        Stake storage s = stakes[msg.sender];
        uint256 amount = s.pendingUnstake;
        if (amount == 0) revert NothingToUnstake();
        if (block.timestamp < s.unlockAt) revert StillLocked(s.unlockAt);
        s.pendingUnstake = 0;
        stakeToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Slash a validator whose verdict was overturned. Slashes active stake first,
    /// then stake waiting to unlock.
    function slash(address validator, uint256 amount, address to, bytes32 requestHash) external onlyOwner nonReentrant {
        Stake storage s = stakes[validator];
        uint256 fromActive = amount <= s.amount ? amount : s.amount;
        s.amount -= fromActive;
        uint256 rest = amount - fromActive;
        if (rest > s.pendingUnstake) rest = s.pendingUnstake;
        s.pendingUnstake -= rest;
        uint256 total = fromActive + rest;
        stakeToken.safeTransfer(to, total);
        emit Slashed(validator, total, to, requestHash);
    }

    // ---------------------------------------------------------------- ERC-8004 validation

    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash)
        external
    {
        if (!identity.exists(agentId)) revert UnknownAgent(agentId);
        if (_requests[requestHash].validator != address(0)) revert RequestExists(requestHash);
        _requests[requestHash] = Request({
            validator: validatorAddress,
            agentId: agentId,
            requester: msg.sender,
            response: 0,
            responded: false,
            responseHash: bytes32(0),
            tag: "",
            lastUpdate: uint64(block.timestamp)
        });
        _agentRequests[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);
        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        Request storage r = _requests[requestHash];
        if (r.validator == address(0)) revert UnknownRequest(requestHash);
        if (r.validator != msg.sender) revert NotValidator(msg.sender);
        if (r.responded) revert AlreadyResponded(requestHash);
        if (response > 100) revert ResponseOutOfRange(response);
        uint256 staked = stakes[msg.sender].amount;
        if (staked < minStake) revert InsufficientStake(msg.sender, staked, minStake);
        r.response = response;
        r.responded = true;
        r.responseHash = responseHash;
        r.tag = tag;
        r.lastUpdate = uint64(block.timestamp);
        emit ValidationResponse(msg.sender, r.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    // ---------------------------------------------------------------- views

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint64 lastUpdate)
    {
        Request storage r = _requests[requestHash];
        return (r.validator, r.agentId, r.response, r.responseHash, r.tag, r.lastUpdate);
    }

    function getRequest(bytes32 requestHash) external view returns (Request memory) {
        return _requests[requestHash];
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentRequests[agentId];
    }

    function getValidatorRequests(address validator) external view returns (bytes32[] memory) {
        return _validatorRequests[validator];
    }
}
