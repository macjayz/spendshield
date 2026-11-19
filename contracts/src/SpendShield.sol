// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice EIP-3009 (USDC-style) signed transfers. tUSD8 on Aevum implements this.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title SpendShield
/// @notice A stablecoin vault that lets an owner hand AI agents a scoped, revocable budget.
///
///         owner ── deposit tUSD8 ──▶ vault
///         owner ── grantSession(agent, policy, merchants) ──▶ vault
///         agent ── pay(owner, merchant, amount, ref) ──▶ vault ── tUSD8 ──▶ merchant
///
///         Every agent payment passes the same checks, in this order:
///           1. owner has not frozen all agents          5. merchant is on the allowlist (or the policy allows any)
///           2. agent holds an active session            6. rolling-period budget is not exceeded
///           3. session has not expired                  7. `ref` was never used by this owner (idempotent retries)
///           4. amount is > 0 and within maxPerPayment   8. owner's vault balance covers it
///
///         Anything an agent can't do on its own (over a cap, unknown merchant) it can escalate with
///         `requestApproval`; the owner settles it with `approveRequest` or `rejectRequest`.
///         Agents can act without native gas: they sign an EIP-712 message and any relayer submits it.
///
/// @dev    Shanghai-safe (no transient storage). The token is fixed at deploy time and is a plain
///         ERC-20 with no transfer hooks (tUSD8), so checks-effects-interactions is enough here.
contract SpendShield is EIP712 {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    /// @notice What an agent may spend. All amounts are in token units (tUSD8 has 6 decimals).
    struct Policy {
        uint128 maxPerPayment; // hard cap on a single payment
        uint128 budgetPerPeriod; // cap on the sum of payments inside one period
        uint32 period; // period length in seconds (e.g. 86400 = daily budget)
        uint64 expiresAt; // unix time after which the session is dead
        bool anyMerchant; // true: pay anyone. false: only allowlisted merchants
    }

    struct Session {
        Policy policy;
        uint64 periodStart;
        uint128 spentInPeriod;
        uint128 totalSpent;
        uint32 epoch; // bumps on every grant and revoke; invalidates old allowlists and signatures
        bool active;
    }

    /// @notice Why a payment would be (or was) refused. `OK` means it would go through.
    enum Reason {
        OK,
        Frozen,
        NoSession,
        Expired,
        ZeroAmount,
        OverPerPaymentCap,
        MerchantNotAllowed,
        OverPeriodBudget,
        RefAlreadyUsed,
        InsufficientBalance
    }

    enum RequestStatus {
        None,
        Pending,
        Approved,
        Rejected
    }

    struct Request {
        address owner;
        address agent;
        address merchant;
        uint128 amount;
        uint64 expiresAt;
        RequestStatus status;
        bytes32 ref;
    }

    // ------------------------------------------------------------------ storage

    IERC20 public immutable token;

    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "AgentPayment(address owner,address merchant,uint256 amount,bytes32 ref,uint32 epoch,uint256 deadline)"
    );
    bytes32 public constant REQUEST_TYPEHASH = keccak256(
        "ApprovalRequest(address owner,address merchant,uint256 amount,bytes32 ref,uint32 epoch,uint256 deadline)"
    );

    uint32 public constant MAX_REQUEST_TTL = 7 days;

    mapping(address owner => uint256) public balanceOf;
    mapping(address owner => bool) public frozen;
    mapping(address owner => mapping(bytes32 ref => bool)) public refUsed;
    mapping(address owner => mapping(address agent => Session)) private _sessions;
    mapping(bytes32 key => bool) private _merchantAllowed; // key = keccak(owner, agent, epoch, merchant)
    mapping(uint256 id => Request) private _requests;
    mapping(address owner => mapping(bytes32 ref => bool)) public refRequested; // one request per ref
    uint256 public requestCount;

    // ------------------------------------------------------------------ events

    event Deposited(address indexed owner, address indexed from, uint256 amount);
    event Withdrawn(address indexed owner, address indexed to, uint256 amount);
    event SessionGranted(address indexed owner, address indexed agent, uint32 epoch, Policy policy);
    event SessionRevoked(address indexed owner, address indexed agent, uint32 epoch);
    event MerchantSet(address indexed owner, address indexed agent, address indexed merchant, bool allowed);
    event FrozenSet(address indexed owner, bool frozen);
    event AgentPaid(
        address indexed owner,
        address indexed agent,
        address indexed merchant,
        bytes32 ref,
        uint256 amount,
        uint256 spentInPeriod
    );
    event ApprovalRequested(
        uint256 indexed id, address indexed owner, address indexed agent, address merchant, uint256 amount, bytes32 ref
    );
    event RequestSettled(uint256 indexed id, address indexed owner, bool approved);

    // ------------------------------------------------------------------ errors

    error PaymentRejected(Reason reason);
    error ZeroAddress();
    error ZeroAmount();
    error InvalidPolicy();
    error InsufficientBalance(uint256 available, uint256 needed);
    error BadSignature();
    error SignatureExpired();
    error UnknownRequest(uint256 id);
    error NotRequestOwner(uint256 id);
    error RequestNotPending(uint256 id);
    error RequestExpired(uint256 id);
    error RefAlreadyUsed(bytes32 ref);
    error RefAlreadyRequested(bytes32 ref);

    constructor(IERC20 token_) EIP712("SpendShield", "1") {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    // ================================================================== owner: funds

    /// @notice Move `amount` of your approved tokens into your vault balance.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, msg.sender, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Gasless deposit: `from` signs an EIP-3009 ReceiveWithAuthorization to this contract,
    ///         anyone submits it. The money is always credited to `from`, so front-running is harmless.
    function depositWithAuthorization(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (amount == 0) revert ZeroAmount();
        balanceOf[from] += amount;
        emit Deposited(from, from, amount);
        IERC3009(address(token)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );
    }

    /// @notice Take money out of your vault at any time. Agents can never call this.
    function withdraw(uint256 amount, address to) external {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (bal < amount) revert InsufficientBalance(bal, amount);
        balanceOf[msg.sender] = bal - amount;
        emit Withdrawn(msg.sender, to, amount);
        token.safeTransfer(to, amount);
    }

    // ================================================================== owner: controls

    /// @notice Give `agent` a fresh session. Replaces any previous session for that agent and
    ///         clears its old allowlist and any signatures it made before.
    function grantSession(address agent, Policy calldata policy, address[] calldata merchants) external {
        if (agent == address(0)) revert ZeroAddress();
        if (
            policy.maxPerPayment == 0 || policy.budgetPerPeriod < policy.maxPerPayment || policy.period == 0
                || policy.expiresAt <= block.timestamp
        ) revert InvalidPolicy();

        Session storage s = _sessions[msg.sender][agent];
        uint32 epoch = s.epoch + 1;
        s.policy = policy;
        s.periodStart = uint64(block.timestamp);
        s.spentInPeriod = 0;
        s.epoch = epoch;
        s.active = true;
        // totalSpent is kept across sessions on purpose: it's the agent's lifetime spend for this owner.

        emit SessionGranted(msg.sender, agent, epoch, policy);
        for (uint256 i; i < merchants.length; ++i) {
            _setMerchant(msg.sender, agent, epoch, merchants[i], true);
        }
    }

    /// @notice Add or remove merchants on an agent's allowlist for its current session.
    function setMerchants(address agent, address[] calldata merchants, bool allowed) external {
        Session storage s = _sessions[msg.sender][agent];
        if (!s.active) revert PaymentRejected(Reason.NoSession);
        for (uint256 i; i < merchants.length; ++i) {
            _setMerchant(msg.sender, agent, s.epoch, merchants[i], allowed);
        }
    }

    /// @notice Kill an agent's session now. Pending signatures from that agent stop working too.
    function revokeSession(address agent) external {
        Session storage s = _sessions[msg.sender][agent];
        s.active = false;
        s.epoch += 1;
        emit SessionRevoked(msg.sender, agent, s.epoch);
    }

    /// @notice Kill switch: block every agent payment from your vault until you unfreeze.
    ///         Withdrawals and your own approvals still work.
    function setFrozen(bool frozen_) external {
        frozen[msg.sender] = frozen_;
        emit FrozenSet(msg.sender, frozen_);
    }

    // ================================================================== agent: pay

    /// @notice Pay `merchant` from `owner`'s vault. The caller is the agent.
    /// @param ref A unique id for this payment (invoice id, request hash). A retry with the same
    ///            ref reverts instead of paying twice.
    function pay(address owner, address merchant, uint256 amount, bytes32 ref) external {
        _pay(owner, msg.sender, merchant, amount, ref);
    }

    /// @notice Gasless agent payment: `agent` signs an AgentPayment, anyone submits it.
    function payWithSig(
        address owner,
        address agent,
        address merchant,
        uint256 amount,
        bytes32 ref,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _checkSig(agent, _digest(PAYMENT_TYPEHASH, owner, agent, merchant, amount, ref, deadline), signature);
        _pay(owner, agent, merchant, amount, ref);
    }

    // ================================================================== agent: escalate

    /// @notice Ask the owner to approve a payment the policy doesn't allow on its own.
    ///         Needs an active session (so random addresses can't spam the owner).
    function requestApproval(address owner, address merchant, uint256 amount, bytes32 ref, uint32 ttl)
        external
        returns (uint256 id)
    {
        return _request(owner, msg.sender, merchant, amount, ref, ttl);
    }

    /// @notice Gasless `requestApproval`, signed by the agent.
    function requestApprovalWithSig(
        address owner,
        address agent,
        address merchant,
        uint256 amount,
        bytes32 ref,
        uint32 ttl,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 id) {
        _checkSig(agent, _digest(REQUEST_TYPEHASH, owner, agent, merchant, amount, ref, deadline), signature);
        return _request(owner, agent, merchant, amount, ref, ttl);
    }

    /// @notice Owner approves and pays a pending request. Skips the agent's caps and allowlist
    ///         (a human signed off), but still needs the vault balance and an unused ref.
    function approveRequest(uint256 id) external {
        Request storage q = _ownRequest(id);
        if (q.expiresAt <= block.timestamp) revert RequestExpired(id);
        if (refUsed[q.owner][q.ref]) revert RefAlreadyUsed(q.ref);
        uint256 bal = balanceOf[q.owner];
        if (bal < q.amount) revert InsufficientBalance(bal, q.amount);

        q.status = RequestStatus.Approved;
        refUsed[q.owner][q.ref] = true;
        balanceOf[q.owner] = bal - q.amount;
        _sessions[q.owner][q.agent].totalSpent += q.amount;

        emit RequestSettled(id, q.owner, true);
        emit AgentPaid(q.owner, q.agent, q.merchant, q.ref, q.amount, _sessions[q.owner][q.agent].spentInPeriod);
        token.safeTransfer(q.merchant, q.amount);
    }

    function rejectRequest(uint256 id) external {
        Request storage q = _ownRequest(id);
        q.status = RequestStatus.Rejected;
        emit RequestSettled(id, q.owner, false);
    }

    // ================================================================== views

    /// @notice Would `agent` paying `amount` to `merchant` from `owner`'s vault go through right now?
    ///         Agents call this before paying to get a plain reason instead of a failed transaction.
    function check(address owner, address agent, address merchant, uint256 amount, bytes32 ref)
        public
        view
        returns (Reason)
    {
        if (frozen[owner]) return Reason.Frozen;
        Session storage s = _sessions[owner][agent];
        if (!s.active) return Reason.NoSession;
        Policy memory p = s.policy;
        if (block.timestamp >= p.expiresAt) return Reason.Expired;
        if (amount == 0) return Reason.ZeroAmount;
        if (amount > p.maxPerPayment) return Reason.OverPerPaymentCap;
        if (!p.anyMerchant && !_merchantAllowed[_merchantKey(owner, agent, s.epoch, merchant)]) {
            return Reason.MerchantNotAllowed;
        }
        if (_spentNow(s) + amount > p.budgetPerPeriod) return Reason.OverPeriodBudget;
        if (refUsed[owner][ref]) return Reason.RefAlreadyUsed;
        if (balanceOf[owner] < amount) return Reason.InsufficientBalance;
        return Reason.OK;
    }

    function sessionOf(address owner, address agent) external view returns (Session memory) {
        return _sessions[owner][agent];
    }

    /// @notice How much `agent` can still spend from `owner`'s vault in the current period
    ///         (also limited by the vault balance). Zero if the session is not usable.
    function remaining(address owner, address agent) external view returns (uint256) {
        Session storage s = _sessions[owner][agent];
        if (frozen[owner] || !s.active || block.timestamp >= s.policy.expiresAt) return 0;
        uint256 left = s.policy.budgetPerPeriod - _spentNow(s);
        uint256 bal = balanceOf[owner];
        return left < bal ? left : bal;
    }

    function isMerchantAllowed(address owner, address agent, address merchant) external view returns (bool) {
        Session storage s = _sessions[owner][agent];
        return s.active && (s.policy.anyMerchant || _merchantAllowed[_merchantKey(owner, agent, s.epoch, merchant)]);
    }

    function requestOf(uint256 id) external view returns (Request memory) {
        return _requests[id];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ================================================================== internals

    function _pay(address owner, address agent, address merchant, uint256 amount, bytes32 ref) private {
        if (merchant == address(0)) revert ZeroAddress();
        Reason reason = check(owner, agent, merchant, amount, ref);
        if (reason != Reason.OK) revert PaymentRejected(reason);

        Session storage s = _sessions[owner][agent];
        if (block.timestamp >= uint256(s.periodStart) + s.policy.period) {
            s.periodStart = uint64(block.timestamp);
            s.spentInPeriod = 0;
        }
        uint128 amt = uint128(amount); // safe: amount <= maxPerPayment (uint128)
        s.spentInPeriod += amt;
        s.totalSpent += amt;
        refUsed[owner][ref] = true;
        balanceOf[owner] -= amount;

        emit AgentPaid(owner, agent, merchant, ref, amount, s.spentInPeriod);
        token.safeTransfer(merchant, amount);
    }

    function _request(address owner, address agent, address merchant, uint256 amount, bytes32 ref, uint32 ttl)
        private
        returns (uint256 id)
    {
        if (merchant == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > type(uint128).max) revert ZeroAmount();
        if (frozen[owner]) revert PaymentRejected(Reason.Frozen);
        Session storage s = _sessions[owner][agent];
        if (!s.active) revert PaymentRejected(Reason.NoSession);
        if (block.timestamp >= s.policy.expiresAt) revert PaymentRejected(Reason.Expired);
        if (refUsed[owner][ref]) revert RefAlreadyUsed(ref);
        if (refRequested[owner][ref]) revert RefAlreadyRequested(ref);
        refRequested[owner][ref] = true;
        if (ttl == 0 || ttl > MAX_REQUEST_TTL) ttl = MAX_REQUEST_TTL;

        id = ++requestCount;
        _requests[id] = Request({
            owner: owner,
            agent: agent,
            merchant: merchant,
            amount: uint128(amount),
            expiresAt: uint64(block.timestamp + ttl),
            status: RequestStatus.Pending,
            ref: ref
        });
        emit ApprovalRequested(id, owner, agent, merchant, amount, ref);
    }

    function _ownRequest(uint256 id) private view returns (Request storage q) {
        q = _requests[id];
        if (q.status == RequestStatus.None) revert UnknownRequest(id);
        if (q.owner != msg.sender) revert NotRequestOwner(id);
        if (q.status != RequestStatus.Pending) revert RequestNotPending(id);
    }

    /// @dev The signed message includes the session epoch, so a revoke (or a new grant) voids every
    ///      signature the agent made before it. `ref` is single-use, so a signature can't be replayed.
    function _digest(
        bytes32 typehash,
        address owner,
        address agent,
        address merchant,
        uint256 amount,
        bytes32 ref,
        uint256 deadline
    ) private view returns (bytes32) {
        if (block.timestamp > deadline) revert SignatureExpired();
        uint32 epoch = _sessions[owner][agent].epoch;
        return _hashTypedDataV4(keccak256(abi.encode(typehash, owner, merchant, amount, ref, epoch, deadline)));
    }

    /// @dev SignatureChecker also accepts ERC-1271 smart-wallet agents.
    function _checkSig(address agent, bytes32 digest, bytes calldata signature) private view {
        if (!SignatureChecker.isValidSignatureNow(agent, digest, signature)) revert BadSignature();
    }

    function _setMerchant(address owner, address agent, uint32 epoch, address merchant, bool allowed) private {
        if (merchant == address(0)) revert ZeroAddress();
        _merchantAllowed[_merchantKey(owner, agent, epoch, merchant)] = allowed;
        emit MerchantSet(owner, agent, merchant, allowed);
    }

    function _spentNow(Session storage s) private view returns (uint256) {
        return block.timestamp >= uint256(s.periodStart) + s.policy.period ? 0 : s.spentInPeriod;
    }

    function _merchantKey(address owner, address agent, uint32 epoch, address merchant)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(owner, agent, epoch, merchant));
    }
}
