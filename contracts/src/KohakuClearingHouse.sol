// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {KohakuIdentityRegistry} from "./KohakuIdentityRegistry.sol";
import {KohakuCollateralVault} from "./KohakuCollateralVault.sol";

/// @title KohakuClearingHouse
/// @notice Central counterparty for agent-to-agent payments.
///
/// Every paid job produces an IOU signed (EIP-712) by the buyer agent. IOUs are collected
/// off chain at full speed. When an epoch closes, the clearing service posts the epoch's
/// IOU set here in chunks. This contract does not trust the service's arithmetic: it
/// verifies every buyer signature against the identity registry, rejects replays and
/// duplicates, and recomputes every agent's credit, debit and net position itself. The
/// service then finalises the epoch by stating the result it expects; if that differs from
/// what the chain computed, finalisation reverts.
///
/// Net debtors settle their exact debt to this contract's pool through HSP. The clearing
/// service records each verified HSP payment against the epoch. A debtor that misses the
/// settlement deadline is defaulted by anyone and its locked collateral is seized. Once
/// every debtor has settled or been covered, anyone can trigger the payout, which pays each
/// net creditor exactly its net position and seals the epoch receipt.
///
/// Ordering rule that makes double counting impossible without per-IOU storage: within an
/// epoch, IOUs must be posted in strictly increasing (buyer, nonce) order, and a buyer's
/// nonces must keep increasing across epochs.
contract KohakuClearingHouse is EIP712, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct IOU {
        uint256 buyer;
        uint256 seller;
        uint256 amount;
        address token;
        bytes32 jobHash;
        bytes32 quoteHash;
        uint64 epoch;
        uint64 nonce;
    }

    enum EpochStatus {
        Open,
        Posting,
        Finalized,
        Settled
    }

    enum PositionState {
        None,
        Flat,
        Owes,
        Settled,
        Defaulted,
        Creditor,
        Paid
    }

    struct Epoch {
        EpochStatus status;
        uint64 finalizedAt;
        uint64 settleDeadline;
        uint64 settledAt;
        uint32 iouCount;
        uint32 participantCount;
        uint32 debtorCount;
        uint32 creditorCount;
        uint32 openDebtors;
        uint32 defaultCount;
        uint32 heldOutCount;
        uint32 carriedCount;
        uint128 grossVolume;
        uint128 netVolume;
        uint256 lastKey;
        bytes32 iouSetHash;
        bytes32 positionsHash;
        bytes32 settlementsHash;
        bytes32 payoutsHash;
        bytes32 receiptHash;
    }

    struct Position {
        uint128 credit;
        uint128 debit;
        PositionState state;
    }

    struct Settlement {
        bytes32 hspPaymentId;
        bytes32 settlementTx;
        bytes32 hspReceiptHash;
        uint64 at;
    }

    bytes32 public constant IOU_TYPEHASH = keccak256(
        "IOU(uint256 buyer,uint256 seller,uint256 amount,address token,bytes32 jobHash,bytes32 quoteHash,uint64 epoch,uint64 nonce)"
    );
    uint256 public constant MAX_IOU_AMOUNT = 1e12; // 1,000,000 units of a 6-decimal stablecoin
    uint64 public constant MIN_SETTLEMENT_WINDOW = 30;
    uint64 public constant MAX_SETTLEMENT_WINDOW = 7 days;

    KohakuIdentityRegistry public immutable identity;
    KohakuCollateralVault public immutable vault;
    IERC20 public immutable token;

    address public clearer;
    uint64 public settlementWindow;
    uint64 public currentEpoch = 1;

    /// @notice Pool funds received from debtors (or seized from collateral) and not yet paid out.
    uint256 public accountedBalance;

    mapping(uint64 epochId => Epoch) private _epochs;
    mapping(uint64 epochId => uint256[]) private _participants;
    mapping(uint64 epochId => mapping(uint256 agentId => Position)) private _positions;
    mapping(uint64 epochId => mapping(uint256 agentId => Settlement)) private _settlements;
    mapping(uint256 buyer => uint64) public lastNonce;
    mapping(bytes32 iouDigest => uint64 originEpoch) public heldOut;
    mapping(bytes32 ref => bool) public usedSettlementRef;

    event ClearerChanged(address indexed clearer);
    event SettlementWindowChanged(uint64 window);
    event IouHeldOut(uint64 indexed epochId, bytes32 indexed iouDigest);
    event HeldOutReleased(uint64 indexed originEpoch, bytes32 indexed iouDigest);
    event IouCarried(uint64 indexed epochId, uint64 indexed originEpoch, bytes32 indexed iouDigest);
    event IousPosted(uint64 indexed epochId, uint256 count, uint32 iouCount, uint128 grossVolume, bytes32 iouSetHash);
    event EpochFinalized(
        uint64 indexed epochId,
        bytes32 iouSetHash,
        bytes32 positionsHash,
        uint32 iouCount,
        uint128 grossVolume,
        uint128 netVolume,
        uint32 debtorCount,
        uint32 creditorCount,
        uint64 settleDeadline
    );
    event DebtorSettled(
        uint64 indexed epochId,
        uint256 indexed agentId,
        uint256 amount,
        bytes32 hspPaymentId,
        bytes32 settlementTx,
        bytes32 hspReceiptHash
    );
    event DebtorDefaulted(uint64 indexed epochId, uint256 indexed agentId, uint256 amount);
    event CreditorPaid(uint64 indexed epochId, uint256 indexed agentId, address indexed to, uint256 amount);
    event EpochSettled(uint64 indexed epochId, bytes32 receiptHash);

    error NotClearer(address caller);
    error WrongEpoch(uint64 expected, uint64 got);
    error BadStatus(uint64 epochId, EpochStatus status);
    error LengthMismatch();
    error IouEpochMismatch(uint64 epochId, uint64 iouEpoch);
    error WrongToken(address token);
    error BadAmount(uint256 amount);
    error SelfDealing(uint256 agentId);
    error UnknownAgent(uint256 agentId);
    error OutOfOrder(uint256 key, uint256 lastKey);
    error NonceReused(uint256 buyer, uint64 nonce, uint64 lastNonce);
    error BadSignature(uint256 buyer, address recovered, address expected);
    error IouIsHeldOut(bytes32 iouDigest);
    error NotHeldOut(bytes32 iouDigest);
    error IouSetMismatch(bytes32 expected, bytes32 actual);
    error PositionsMismatch(bytes32 expected, bytes32 actual);
    error NotADebtor(uint64 epochId, uint256 agentId);
    error RefAlreadyUsed(bytes32 ref);
    error PaymentNotReceived(uint256 required, uint256 available);
    error DeadlineNotReached(uint64 deadline);
    error DebtorsOutstanding(uint32 openDebtors);
    error BadWindow(uint64 window);
    error ZeroAddress();

    constructor(
        KohakuIdentityRegistry identity_,
        KohakuCollateralVault vault_,
        IERC20 token_,
        address clearer_,
        uint64 settlementWindow_,
        address owner_
    ) EIP712("Kohaku Clearing House", "1") Ownable(owner_) {
        if (clearer_ == address(0)) revert ZeroAddress();
        if (settlementWindow_ < MIN_SETTLEMENT_WINDOW || settlementWindow_ > MAX_SETTLEMENT_WINDOW) {
            revert BadWindow(settlementWindow_);
        }
        identity = identity_;
        vault = vault_;
        token = token_;
        clearer = clearer_;
        settlementWindow = settlementWindow_;
        emit ClearerChanged(clearer_);
        emit SettlementWindowChanged(settlementWindow_);
    }

    modifier onlyClearer() {
        if (msg.sender != clearer) revert NotClearer(msg.sender);
        _;
    }

    // ---------------------------------------------------------------- admin (minimal)

    /// @notice Rotate the clearing service key. The clearer can post and finalise epochs and
    /// record HSP settlements; it can never move pool funds or collateral by itself.
    function setClearer(address clearer_) external onlyOwner {
        if (clearer_ == address(0)) revert ZeroAddress();
        clearer = clearer_;
        emit ClearerChanged(clearer_);
    }

    function setSettlementWindow(uint64 window) external onlyOwner {
        if (window < MIN_SETTLEMENT_WINDOW || window > MAX_SETTLEMENT_WINDOW) revert BadWindow(window);
        settlementWindow = window;
        emit SettlementWindowChanged(window);
    }

    // ---------------------------------------------------------------- posting

    /// @notice Declare IOUs of the current epoch that are held out of netting because a
    /// dispute on them was still open at close. Must happen before the epoch's IOUs are
    /// posted. A held-out IOU is either carried into a later epoch (dispute rejected) or
    /// released and never counted (dispute upheld).
    function holdOut(uint64 epochId, bytes32[] calldata digests) external onlyClearer {
        Epoch storage e = _openForPosting(epochId);
        if (e.status != EpochStatus.Open) revert BadStatus(epochId, e.status);
        for (uint256 i = 0; i < digests.length; i++) {
            heldOut[digests[i]] = epochId;
            emit IouHeldOut(epochId, digests[i]);
        }
        e.heldOutCount += uint32(digests.length);
    }

    function releaseHeldOut(bytes32 digest) external onlyClearer {
        uint64 origin = heldOut[digest];
        if (origin == 0) revert NotHeldOut(digest);
        delete heldOut[digest];
        emit HeldOutReleased(origin, digest);
    }

    /// @notice Post a held-out IOU whose dispute was rejected into the current epoch.
    function postCarried(uint64 epochId, IOU calldata iou, bytes calldata signature) external onlyClearer {
        Epoch storage e = _openForPosting(epochId);
        bytes32 digest = iouDigest(iou);
        uint64 origin = heldOut[digest];
        if (origin == 0 || origin != iou.epoch || origin >= epochId) revert NotHeldOut(digest);
        delete heldOut[digest];
        _checkIou(iou, digest, signature);
        _accumulate(e, epochId, iou, digest);
        e.carriedCount += 1;
        e.status = EpochStatus.Posting;
        emit IouCarried(epochId, origin, digest);
        emit IousPosted(epochId, 1, e.iouCount, e.grossVolume, e.iouSetHash);
    }

    /// @notice Post a chunk of the current epoch's IOU set. Chunks must arrive in order and
    /// IOUs must be sorted by (buyer, nonce) strictly ascending across the whole epoch.
    function postIous(uint64 epochId, IOU[] calldata ious, bytes[] calldata signatures) external onlyClearer {
        if (ious.length != signatures.length) revert LengthMismatch();
        Epoch storage e = _openForPosting(epochId);
        uint256 lastKey = e.lastKey;
        for (uint256 i = 0; i < ious.length; i++) {
            IOU calldata iou = ious[i];
            if (iou.epoch != epochId) revert IouEpochMismatch(epochId, iou.epoch);
            uint256 key = (iou.buyer << 64) | uint256(iou.nonce);
            if (key <= lastKey) revert OutOfOrder(key, lastKey);
            lastKey = key;
            uint64 prev = lastNonce[iou.buyer];
            if (iou.nonce <= prev) revert NonceReused(iou.buyer, iou.nonce, prev);
            lastNonce[iou.buyer] = iou.nonce;
            bytes32 digest = iouDigest(iou);
            if (heldOut[digest] != 0) revert IouIsHeldOut(digest);
            _checkIou(iou, digest, signatures[i]);
            _accumulate(e, epochId, iou, digest);
        }
        e.lastKey = lastKey;
        e.status = EpochStatus.Posting;
        emit IousPosted(epochId, ious.length, e.iouCount, e.grossVolume, e.iouSetHash);
    }

    // ---------------------------------------------------------------- netting

    /// @notice Close the books for the current epoch. The chain has already computed every
    /// position from the posted IOUs; the clearer states the IOU-set commitment and the
    /// positions commitment it expects, and the call reverts if either differs. Every net
    /// debtor's debt is locked in the collateral vault (reverting if any debtor is not
    /// covered, which the clearing service must have prevented when accepting IOUs).
    function finalizeEpoch(uint64 epochId, bytes32 expectedIouSetHash, bytes32 expectedPositionsHash)
        external
        onlyClearer
    {
        Epoch storage e = _openForPosting(epochId);
        if (e.iouSetHash != expectedIouSetHash) revert IouSetMismatch(expectedIouSetHash, e.iouSetHash);

        bytes32 positionsHash = _net(epochId, e);
        if (positionsHash != expectedPositionsHash) revert PositionsMismatch(expectedPositionsHash, positionsHash);

        e.positionsHash = positionsHash;
        e.finalizedAt = uint64(block.timestamp);
        e.settleDeadline = uint64(block.timestamp) + settlementWindow;
        e.status = EpochStatus.Finalized;
        currentEpoch = epochId + 1;

        emit EpochFinalized(
            epochId,
            e.iouSetHash,
            positionsHash,
            e.iouCount,
            e.grossVolume,
            e.netVolume,
            e.debtorCount,
            e.creditorCount,
            e.settleDeadline
        );

        if (e.debtorCount == 0) _seal(epochId, e); // nothing to settle: the epoch is sealed immediately
    }

    /// @dev Turns accumulated credits and debits into net positions, locks every debtor's
    /// net debit in the vault and returns the positions commitment.
    function _net(uint64 epochId, Epoch storage e) private returns (bytes32 positionsHash) {
        uint256[] storage parts = _participants[epochId];
        uint256 totalCredit;
        uint256 totalDebit;
        uint128 netVolume;
        uint32 debtors;
        uint32 creditors;
        for (uint256 i = 0; i < parts.length; i++) {
            uint256 agentId = parts[i];
            Position storage p = _positions[epochId][agentId];
            totalCredit += p.credit;
            totalDebit += p.debit;
            positionsHash = keccak256(abi.encode(positionsHash, agentId, p.credit, p.debit));
            if (p.debit > p.credit) {
                vault.lock(agentId, p.debit - p.credit);
                p.state = PositionState.Owes;
                debtors++;
            } else if (p.credit > p.debit) {
                netVolume += p.credit - p.debit;
                p.state = PositionState.Creditor;
                creditors++;
            }
        }
        // Net positions across all agents sum to zero by construction; assert it anyway.
        assert(totalCredit == totalDebit && totalCredit == e.grossVolume);
        e.netVolume = netVolume;
        e.debtorCount = debtors;
        e.creditorCount = creditors;
        e.openDebtors = debtors;
        e.participantCount = uint32(parts.length);
    }

    // ---------------------------------------------------------------- settlement

    /// @notice Record a debtor's verified HSP settlement. The clearing service calls this
    /// only after the HSP payment for exactly this debt reached ACCEPT; the contract adds a
    /// second, independent check that the money actually arrived in the pool.
    function recordSettlement(
        uint64 epochId,
        uint256 agentId,
        bytes32 hspPaymentId,
        bytes32 settlementTx,
        bytes32 hspReceiptHash
    ) external onlyClearer nonReentrant {
        Epoch storage e = _epochs[epochId];
        if (e.status != EpochStatus.Finalized) revert BadStatus(epochId, e.status);
        Position storage p = _positions[epochId][agentId];
        if (p.state != PositionState.Owes) revert NotADebtor(epochId, agentId);
        if (usedSettlementRef[hspPaymentId]) revert RefAlreadyUsed(hspPaymentId);
        if (usedSettlementRef[settlementTx]) revert RefAlreadyUsed(settlementTx);
        usedSettlementRef[hspPaymentId] = true;
        usedSettlementRef[settlementTx] = true;

        uint256 owed = p.debit - p.credit;
        uint256 balance = token.balanceOf(address(this));
        if (balance < accountedBalance + owed) {
            revert PaymentNotReceived(owed, balance > accountedBalance ? balance - accountedBalance : 0);
        }
        accountedBalance += owed;

        vault.unlock(agentId, owed);
        p.state = PositionState.Settled;
        e.openDebtors -= 1;
        _settlements[epochId][agentId] = Settlement({
            hspPaymentId: hspPaymentId,
            settlementTx: settlementTx,
            hspReceiptHash: hspReceiptHash,
            at: uint64(block.timestamp)
        });
        e.settlementsHash =
            keccak256(abi.encode(e.settlementsHash, agentId, owed, hspPaymentId, settlementTx, hspReceiptHash));
        emit DebtorSettled(epochId, agentId, owed, hspPaymentId, settlementTx, hspReceiptHash);
    }

    /// @notice Anyone can default a debtor that missed the settlement deadline. Its locked
    /// collateral covers the debt in full, so creditors are always paid.
    function declareDefault(uint64 epochId, uint256 agentId) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        if (e.status != EpochStatus.Finalized) revert BadStatus(epochId, e.status);
        if (block.timestamp <= e.settleDeadline) revert DeadlineNotReached(e.settleDeadline);
        Position storage p = _positions[epochId][agentId];
        if (p.state != PositionState.Owes) revert NotADebtor(epochId, agentId);

        uint256 owed = p.debit - p.credit;
        vault.seize(agentId, owed, address(this));
        accountedBalance += owed;
        p.state = PositionState.Defaulted;
        e.openDebtors -= 1;
        e.defaultCount += 1;
        e.settlementsHash = keccak256(abi.encode(e.settlementsHash, agentId, owed, bytes32("DEFAULT"), bytes32(0), bytes32(0)));
        emit DebtorDefaulted(epochId, agentId, owed);
    }

    /// @notice Pay every net creditor exactly its net position and seal the epoch. Callable
    /// by anyone once no debtor is outstanding.
    function payout(uint64 epochId) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        if (e.status != EpochStatus.Finalized) revert BadStatus(epochId, e.status);
        if (e.openDebtors != 0) revert DebtorsOutstanding(e.openDebtors);

        uint256[] storage parts = _participants[epochId];
        bytes32 payoutsHash;
        uint256 paid;
        for (uint256 i = 0; i < parts.length; i++) {
            uint256 agentId = parts[i];
            Position storage p = _positions[epochId][agentId];
            if (p.state != PositionState.Creditor) continue;
            uint256 amount = p.credit - p.debit;
            address to = identity.signerOf(agentId);
            p.state = PositionState.Paid;
            paid += amount;
            payoutsHash = keccak256(abi.encode(payoutsHash, agentId, to, amount));
            token.safeTransfer(to, amount);
            emit CreditorPaid(epochId, agentId, to, amount);
        }
        // Debts in == payouts out, exactly. No rounding anywhere: all amounts are integers.
        assert(paid == e.netVolume);
        accountedBalance -= paid;
        e.payoutsHash = payoutsHash;
        _seal(epochId, e);
    }

    // ---------------------------------------------------------------- internals

    function _openForPosting(uint64 epochId) private view returns (Epoch storage e) {
        if (epochId != currentEpoch) revert WrongEpoch(currentEpoch, epochId);
        e = _epochs[epochId];
        if (e.status != EpochStatus.Open && e.status != EpochStatus.Posting) revert BadStatus(epochId, e.status);
    }

    function _checkIou(IOU calldata iou, bytes32 digest, bytes calldata signature) private view {
        if (iou.token != address(token)) revert WrongToken(iou.token);
        if (iou.amount == 0 || iou.amount > MAX_IOU_AMOUNT) revert BadAmount(iou.amount);
        if (iou.buyer == iou.seller) revert SelfDealing(iou.buyer);
        if (!identity.exists(iou.seller)) revert UnknownAgent(iou.seller);
        address expected = identity.signerOf(iou.buyer);
        if (expected == address(0)) revert UnknownAgent(iou.buyer);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != expected) {
            revert BadSignature(iou.buyer, recovered, expected);
        }
    }

    function _accumulate(Epoch storage e, uint64 epochId, IOU calldata iou, bytes32 digest) private {
        Position storage pb = _touch(epochId, iou.buyer);
        Position storage ps = _touch(epochId, iou.seller);
        // safe: _checkIou bounds amount by MAX_IOU_AMOUNT (1e12) before we get here
        uint128 amount = uint128(iou.amount);
        pb.debit += amount;
        ps.credit += amount;
        e.iouCount += 1;
        e.grossVolume += amount;
        e.iouSetHash = keccak256(abi.encode(e.iouSetHash, digest));
    }

    function _touch(uint64 epochId, uint256 agentId) private returns (Position storage p) {
        p = _positions[epochId][agentId];
        if (p.state == PositionState.None) {
            p.state = PositionState.Flat;
            _participants[epochId].push(agentId);
        }
    }

    function _seal(uint64 epochId, Epoch storage e) private {
        e.status = EpochStatus.Settled;
        e.settledAt = uint64(block.timestamp);
        e.receiptHash = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                epochId,
                e.iouSetHash,
                e.positionsHash,
                e.settlementsHash,
                e.payoutsHash
            )
        );
        emit EpochSettled(epochId, e.receiptHash);
    }

    // ---------------------------------------------------------------- views

    function iouDigest(IOU calldata iou) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    IOU_TYPEHASH,
                    iou.buyer,
                    iou.seller,
                    iou.amount,
                    iou.token,
                    iou.jobHash,
                    iou.quoteHash,
                    iou.epoch,
                    iou.nonce
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function getEpoch(uint64 epochId) external view returns (Epoch memory) {
        return _epochs[epochId];
    }

    function getParticipants(uint64 epochId) external view returns (uint256[] memory) {
        return _participants[epochId];
    }

    function getPosition(uint64 epochId, uint256 agentId)
        external
        view
        returns (uint128 credit, uint128 debit, int256 net, PositionState state)
    {
        Position storage p = _positions[epochId][agentId];
        return (p.credit, p.debit, int256(uint256(p.credit)) - int256(uint256(p.debit)), p.state);
    }

    function getSettlement(uint64 epochId, uint256 agentId) external view returns (Settlement memory) {
        return _settlements[epochId][agentId];
    }
}
