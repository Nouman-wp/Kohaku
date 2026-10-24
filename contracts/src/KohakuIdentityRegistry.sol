// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title KohakuIdentityRegistry
/// @notice Agent identity registry in the spirit of ERC-8004 (Trustless Agents).
/// Every agent is an ERC-721 token owned by its operator. The token URI points at the
/// agent card (A2A format). Each agent also has a signing wallet: the key that signs
/// quotes, IOUs and deliveries, settles debts through HSP and receives payouts.
contract KohakuIdentityRegistry is ERC721 {
    enum Status {
        None,
        Active,
        Paused,
        Retired
    }

    struct Agent {
        address signer;
        Status status;
        uint64 registeredAt;
        string agentURI;
    }

    struct MetadataEntry {
        string key;
        bytes value;
    }

    uint256 public totalAgents;

    mapping(uint256 agentId => Agent) private _agents;
    mapping(address signer => uint256 agentId) public agentIdOfSigner;
    mapping(uint256 agentId => mapping(string key => bytes value)) private _metadata;

    // ERC-8004 identity events
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(uint256 indexed agentId, string indexed indexedKey, string key, bytes value);
    // Kohaku lifecycle events
    event SignerChanged(uint256 indexed agentId, address indexed signer);
    event StatusChanged(uint256 indexed agentId, Status status);

    error NotOperator(uint256 agentId, address caller);
    error UnknownAgent(uint256 agentId);
    error SignerTaken(address signer, uint256 agentId);
    error InvalidSigner();
    error AgentRetired(uint256 agentId);
    error BadStatusTransition(Status from, Status to);

    constructor() ERC721("Kohaku Agent", "KAGENT") {}

    modifier onlyOperator(uint256 agentId) {
        if (_agents[agentId].status == Status.None) revert UnknownAgent(agentId);
        if (ownerOf(agentId) != msg.sender) revert NotOperator(agentId, msg.sender);
        _;
    }

    // ---------------------------------------------------------------- registration

    /// @notice ERC-8004 style registration. The caller is both operator and signer.
    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _register(agentURI, msg.sender);
    }

    /// @notice Register an agent whose signing wallet differs from the operator.
    function register(string calldata agentURI, address signer, MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId)
    {
        agentId = _register(agentURI, signer);
        for (uint256 i = 0; i < metadata.length; i++) {
            _setMetadata(agentId, metadata[i].key, metadata[i].value);
        }
    }

    function _register(string calldata agentURI, address signer) private returns (uint256 agentId) {
        if (signer == address(0)) revert InvalidSigner();
        if (agentIdOfSigner[signer] != 0) revert SignerTaken(signer, agentIdOfSigner[signer]);
        agentId = ++totalAgents;
        _agents[agentId] = Agent({
            signer: signer,
            status: Status.Active,
            registeredAt: uint64(block.timestamp),
            agentURI: agentURI
        });
        agentIdOfSigner[signer] = agentId;
        _safeMint(msg.sender, agentId);
        emit Registered(agentId, agentURI, msg.sender);
        emit SignerChanged(agentId, signer);
        emit StatusChanged(agentId, Status.Active);
    }

    // ---------------------------------------------------------------- operator actions

    function setAgentURI(uint256 agentId, string calldata newURI) external onlyOperator(agentId) {
        _agents[agentId].agentURI = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function setMetadata(uint256 agentId, string calldata key, bytes calldata value)
        external
        onlyOperator(agentId)
    {
        _setMetadata(agentId, key, value);
    }

    /// @notice Rotate the agent's signing wallet. Open obligations stay with the agent id,
    /// payouts follow the new wallet.
    function setSigner(uint256 agentId, address signer) external onlyOperator(agentId) {
        if (signer == address(0)) revert InvalidSigner();
        if (agentIdOfSigner[signer] != 0) revert SignerTaken(signer, agentIdOfSigner[signer]);
        delete agentIdOfSigner[_agents[agentId].signer];
        _agents[agentId].signer = signer;
        agentIdOfSigner[signer] = agentId;
        emit SignerChanged(agentId, signer);
    }

    function pause(uint256 agentId) external onlyOperator(agentId) {
        _transition(agentId, Status.Active, Status.Paused);
    }

    function unpause(uint256 agentId) external onlyOperator(agentId) {
        _transition(agentId, Status.Paused, Status.Active);
    }

    /// @notice Retire an agent for good. It can take no new jobs, but every obligation it
    /// already signed still clears and settles.
    function retire(uint256 agentId) external onlyOperator(agentId) {
        Status s = _agents[agentId].status;
        if (s == Status.Retired) revert AgentRetired(agentId);
        _agents[agentId].status = Status.Retired;
        emit StatusChanged(agentId, Status.Retired);
    }

    function _transition(uint256 agentId, Status from, Status to) private {
        Status s = _agents[agentId].status;
        if (s != from) revert BadStatusTransition(s, to);
        _agents[agentId].status = to;
        emit StatusChanged(agentId, to);
    }

    function _setMetadata(uint256 agentId, string memory key, bytes memory value) private {
        _metadata[agentId][key] = value;
        emit MetadataSet(agentId, key, key, value);
    }

    // ---------------------------------------------------------------- views

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        return _agents[agentId];
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory) {
        return _metadata[agentId][key];
    }

    function signerOf(uint256 agentId) external view returns (address) {
        return _agents[agentId].signer;
    }

    function statusOf(uint256 agentId) external view returns (Status) {
        return _agents[agentId].status;
    }

    function operatorOf(uint256 agentId) external view returns (address) {
        return ownerOf(agentId);
    }

    function isActive(uint256 agentId) external view returns (bool) {
        return _agents[agentId].status == Status.Active;
    }

    function exists(uint256 agentId) external view returns (bool) {
        return _agents[agentId].status != Status.None;
    }

    function tokenURI(uint256 agentId) public view override returns (string memory) {
        _requireOwned(agentId);
        return _agents[agentId].agentURI;
    }
}
