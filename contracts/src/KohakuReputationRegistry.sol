// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {KohakuIdentityRegistry} from "./KohakuIdentityRegistry.sol";

/// @title KohakuReputationRegistry
/// @notice Reputation registry following the ERC-8004 feedback interface. Anyone can leave
/// feedback for an agent they do not operate. The Kohaku clearing service (the "scorer")
/// additionally writes one objective score per agent at the end of every epoch, computed
/// from jobs, volume, disputes, defaults and settlement punctuality. The formula is public
/// (see docs/REPUTATION.md) and reproducible from the epoch record.
contract KohakuReputationRegistry is Ownable {
    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        bool isRevoked;
        string tag1;
        string tag2;
    }

    KohakuIdentityRegistry public immutable identity;
    address public scorer;

    string public constant SCORE_TAG = "kohaku.score";
    uint8 public constant SCORE_DECIMALS = 1; // scores are 0..1000 => 0.0..100.0

    mapping(uint256 agentId => mapping(address client => Feedback[])) private _feedback;
    mapping(uint256 agentId => address[]) private _clients;
    mapping(uint256 agentId => mapping(address client => bool)) private _isClient;

    /// @notice Latest Kohaku score per agent (0..1000) and the epoch it was computed for.
    mapping(uint256 agentId => int128) public latestScore;
    mapping(uint256 agentId => uint64) public latestScoreEpoch;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);
    event EpochScoresRecorded(uint64 indexed epochId, uint256 agents, bytes32 detailsHash);
    event ScorerChanged(address indexed scorer);

    error UnknownAgent(uint256 agentId);
    error SelfFeedback(uint256 agentId);
    error BadDecimals(uint8 decimals);
    error NotScorer(address caller);
    error LengthMismatch();
    error StaleEpoch(uint256 agentId, uint64 epochId);
    error ScoreOutOfRange(int128 score);
    error NoSuchFeedback();

    constructor(KohakuIdentityRegistry identity_, address scorer_, address owner_) Ownable(owner_) {
        identity = identity_;
        scorer = scorer_;
        emit ScorerChanged(scorer_);
    }

    function setScorer(address scorer_) external onlyOwner {
        scorer = scorer_;
        emit ScorerChanged(scorer_);
    }

    // ---------------------------------------------------------------- ERC-8004 feedback

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        if (!identity.exists(agentId)) revert UnknownAgent(agentId);
        if (identity.operatorOf(agentId) == msg.sender || identity.signerOf(agentId) == msg.sender) {
            revert SelfFeedback(agentId);
        }
        if (valueDecimals > 18) revert BadDecimals(valueDecimals);
        _record(agentId, msg.sender, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        Feedback[] storage list = _feedback[agentId][msg.sender];
        if (feedbackIndex >= list.length) revert NoSuchFeedback();
        list[feedbackIndex].isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    // ---------------------------------------------------------------- Kohaku epoch scores

    /// @notice Write the objective per-epoch scores. One feedback entry per agent, tagged
    /// `kohaku.score` / `epoch:<id>`, plus a cheap latestScore lookup for buyers filtering by
    /// reputation. `detailsHash` commits to the full per-agent inputs published off chain.
    function recordEpochScores(
        uint64 epochId,
        uint256[] calldata agentIds,
        int128[] calldata scores,
        bytes32 detailsHash,
        string calldata detailsURI
    ) external {
        if (msg.sender != scorer) revert NotScorer(msg.sender);
        if (agentIds.length != scores.length) revert LengthMismatch();
        string memory tag2 = string.concat("epoch:", _toString(epochId));
        for (uint256 i = 0; i < agentIds.length; i++) {
            uint256 agentId = agentIds[i];
            int128 score = scores[i];
            if (!identity.exists(agentId)) revert UnknownAgent(agentId);
            if (score < 0 || score > 1000) revert ScoreOutOfRange(score);
            if (latestScoreEpoch[agentId] >= epochId && latestScoreEpoch[agentId] != 0) {
                revert StaleEpoch(agentId, epochId);
            }
            latestScore[agentId] = score;
            latestScoreEpoch[agentId] = epochId;
            _record(agentId, msg.sender, score, SCORE_DECIMALS, SCORE_TAG, tag2, "", detailsURI, detailsHash);
        }
        emit EpochScoresRecorded(epochId, agentIds.length, detailsHash);
    }

    // ---------------------------------------------------------------- views

    function readFeedback(uint256 agentId, address clientAddress, uint64 index)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        Feedback storage f = _feedback[agentId][clientAddress][index];
        return (f.value, f.valueDecimals, f.tag1, f.tag2, f.isRevoked);
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return uint64(_feedback[agentId][clientAddress].length);
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    /// @notice Average of non-revoked feedback, normalised to 18 decimals, optionally filtered
    /// by client list and tags (empty string = no filter).
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        address[] memory clients = clientAddresses;
        if (clients.length == 0) clients = _clients[agentId];
        // bytes32(0) means "no filter" for that tag
        (count, summaryValue) = _summary(
            agentId,
            clients,
            bytes(tag1).length > 0 ? keccak256(bytes(tag1)) : bytes32(0),
            bytes(tag2).length > 0 ? keccak256(bytes(tag2)) : bytes32(0)
        );
        summaryValueDecimals = 18;
    }

    function _summary(uint256 agentId, address[] memory clients, bytes32 t1, bytes32 t2)
        private
        view
        returns (uint64 count, int128 average)
    {
        int256 sum;
        for (uint256 c = 0; c < clients.length; c++) {
            (int256 s, uint64 n) = _sumFor(_feedback[agentId][clients[c]], t1, t2);
            sum += s;
            count += n;
        }
        if (count > 0) average = int128(sum / int256(uint256(count)));
    }

    function _sumFor(Feedback[] storage list, bytes32 t1, bytes32 t2) private view returns (int256 sum, uint64 count) {
        for (uint256 i = 0; i < list.length; i++) {
            Feedback storage f = list[i];
            if (f.isRevoked) continue;
            if (t1 != bytes32(0) && keccak256(bytes(f.tag1)) != t1) continue;
            if (t2 != bytes32(0) && keccak256(bytes(f.tag2)) != t2) continue;
            sum += int256(f.value) * int256(10 ** (18 - f.valueDecimals));
            count++;
        }
    }

    // ---------------------------------------------------------------- internals

    function _record(
        uint256 agentId,
        address client,
        int128 value,
        uint8 valueDecimals,
        string memory tag1,
        string memory tag2,
        string memory endpoint,
        string memory feedbackURI,
        bytes32 feedbackHash
    ) private {
        if (!_isClient[agentId][client]) {
            _isClient[agentId][client] = true;
            _clients[agentId].push(client);
        }
        Feedback[] storage list = _feedback[agentId][client];
        uint64 index = uint64(list.length);
        list.push(Feedback({value: value, valueDecimals: valueDecimals, isRevoked: false, tag1: tag1, tag2: tag2}));
        emit NewFeedback(agentId, client, index, value, valueDecimals, tag1, tag1, tag2, endpoint, feedbackURI, feedbackHash);
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory out = new bytes(len);
        for (; v != 0; v /= 10) out[--len] = bytes1(uint8(48 + v % 10));
        return string(out);
    }
}
