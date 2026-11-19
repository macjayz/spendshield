// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpendShield} from "../src/SpendShield.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

contract SpendShieldTest is Test {
    MockUSD8 token;
    SpendShield shield;

    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address merchant = makeAddr("merchant");
    address other = makeAddr("otherMerchant");
    address relayer = makeAddr("relayer");

    uint128 constant PER_TX = 2e6; // 2 tUSD8
    uint128 constant BUDGET = 5e6; // 5 tUSD8 per day
    uint32 constant DAY = 1 days;

    function setUp() public {
        vm.warp(1_800_000_000);
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        token = new MockUSD8();
        shield = new SpendShield(IERC20(address(token)));
        token.mint(owner, 100e6);

        vm.startPrank(owner);
        token.approve(address(shield), type(uint256).max);
        shield.deposit(20e6);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _policy(bool anyMerchant) internal view returns (SpendShield.Policy memory) {
        return SpendShield.Policy({
            maxPerPayment: PER_TX,
            budgetPerPeriod: BUDGET,
            period: DAY,
            expiresAt: uint64(block.timestamp + 7 days),
            anyMerchant: anyMerchant
        });
    }

    function _grant() internal {
        address[] memory m = new address[](1);
        m[0] = merchant;
        vm.prank(owner);
        shield.grantSession(agent, _policy(false), m);
    }

    function _pay(uint256 amount, bytes32 ref) internal {
        vm.prank(agent);
        shield.pay(owner, merchant, amount, ref);
    }

    function _expectReject(SpendShield.Reason r) internal {
        vm.expectRevert(abi.encodeWithSelector(SpendShield.PaymentRejected.selector, r));
    }

    function _sign(bytes32 typehash, uint256 key, address merchant_, uint256 amount, bytes32 ref, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        uint32 epoch = shield.sessionOf(owner, vm.addr(key)).epoch;
        bytes32 structHash = keccak256(abi.encode(typehash, owner, merchant_, amount, ref, epoch, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", shield.domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------- funds

    function test_deposit_and_withdraw() public {
        assertEq(shield.balanceOf(owner), 20e6);
        assertEq(token.balanceOf(address(shield)), 20e6);

        vm.prank(owner);
        shield.withdraw(5e6, owner);
        assertEq(shield.balanceOf(owner), 15e6);
        assertEq(token.balanceOf(owner), 85e6);
    }

    function test_withdraw_moreThanBalance_reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendShield.InsufficientBalance.selector, 20e6, 21e6));
        shield.withdraw(21e6, owner);
    }

    function test_agentCannotWithdrawOwnerFunds() public {
        _grant();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendShield.InsufficientBalance.selector, 0, 1));
        shield.withdraw(1, agent);
    }

    function test_depositWithAuthorization_creditsSigner() public {
        bytes32 nonce = keccak256("deposit-1");
        Signing.Auth memory a = Signing.Auth({
            from: owner,
            to: address(shield),
            value: 3e6,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, ownerKey, token.DOMAIN_SEPARATOR(), a);
        vm.prank(relayer);
        shield.depositWithAuthorization(owner, 3e6, 0, a.validBefore, nonce, v, r, s);
        assertEq(shield.balanceOf(owner), 23e6);
        assertEq(shield.balanceOf(relayer), 0);
    }

    // ---------------------------------------------------------------- grant

    function test_grant_rejectsBadPolicies() public {
        address[] memory none;
        SpendShield.Policy memory p = _policy(true);

        p.maxPerPayment = 0;
        vm.prank(owner);
        vm.expectRevert(SpendShield.InvalidPolicy.selector);
        shield.grantSession(agent, p, none);

        p = _policy(true);
        p.budgetPerPeriod = PER_TX - 1;
        vm.prank(owner);
        vm.expectRevert(SpendShield.InvalidPolicy.selector);
        shield.grantSession(agent, p, none);

        p = _policy(true);
        p.period = 0;
        vm.prank(owner);
        vm.expectRevert(SpendShield.InvalidPolicy.selector);
        shield.grantSession(agent, p, none);

        p = _policy(true);
        p.expiresAt = uint64(block.timestamp);
        vm.prank(owner);
        vm.expectRevert(SpendShield.InvalidPolicy.selector);
        shield.grantSession(agent, p, none);
    }

    // ---------------------------------------------------------------- pay

    function test_pay_happyPath() public {
        _grant();
        vm.expectEmit(true, true, true, true, address(shield));
        emit SpendShield.AgentPaid(owner, agent, merchant, "r1", 1.5e6, 1.5e6);
        _pay(1.5e6, "r1");

        assertEq(token.balanceOf(merchant), 1.5e6);
        assertEq(shield.balanceOf(owner), 18.5e6);
        assertEq(shield.remaining(owner, agent), BUDGET - 1.5e6);
        SpendShield.Session memory s = shield.sessionOf(owner, agent);
        assertEq(s.spentInPeriod, 1.5e6);
        assertEq(s.totalSpent, 1.5e6);
    }

    function test_pay_withoutSession() public {
        _expectReject(SpendShield.Reason.NoSession);
        _pay(1e6, "r1");
    }

    function test_pay_overPerPaymentCap() public {
        _grant();
        _expectReject(SpendShield.Reason.OverPerPaymentCap);
        _pay(PER_TX + 1, "r1");
    }

    function test_pay_zero() public {
        _grant();
        _expectReject(SpendShield.Reason.ZeroAmount);
        _pay(0, "r1");
    }

    function test_pay_merchantNotAllowed() public {
        _grant();
        vm.prank(agent);
        _expectReject(SpendShield.Reason.MerchantNotAllowed);
        shield.pay(owner, other, 1e6, "r1");
    }

    function test_pay_anyMerchant() public {
        address[] memory none;
        vm.prank(owner);
        shield.grantSession(agent, _policy(true), none);
        vm.prank(agent);
        shield.pay(owner, other, 1e6, "r1");
        assertEq(token.balanceOf(other), 1e6);
    }

    function test_pay_periodBudget_andRollover() public {
        _grant();
        _pay(2e6, "a");
        _pay(2e6, "b");
        _expectReject(SpendShield.Reason.OverPeriodBudget);
        _pay(2e6, "c");
        _pay(1e6, "c"); // exactly hits the 5 tUSD8 budget
        assertEq(shield.remaining(owner, agent), 0);

        vm.warp(block.timestamp + DAY);
        assertEq(shield.remaining(owner, agent), BUDGET);
        _pay(2e6, "d");
        assertEq(shield.sessionOf(owner, agent).spentInPeriod, 2e6);
        assertEq(shield.sessionOf(owner, agent).totalSpent, 7e6);
    }

    function test_pay_sameRefTwice_isRefused() public {
        _grant();
        _pay(1e6, "invoice-42");
        _expectReject(SpendShield.Reason.RefAlreadyUsed);
        _pay(1e6, "invoice-42");
        assertEq(token.balanceOf(merchant), 1e6);
    }

    function test_pay_insufficientVaultBalance() public {
        _grant();
        vm.prank(owner);
        shield.withdraw(19e6, owner); // 1 tUSD8 left
        _expectReject(SpendShield.Reason.InsufficientBalance);
        _pay(1.5e6, "r1");
        assertEq(shield.remaining(owner, agent), 1e6);
    }

    function test_pay_afterExpiry() public {
        _grant();
        vm.warp(block.timestamp + 7 days);
        _expectReject(SpendShield.Reason.Expired);
        _pay(1e6, "r1");
        assertEq(shield.remaining(owner, agent), 0);
    }

    // ---------------------------------------------------------------- controls

    function test_revoke_stopsAgentAtOnce() public {
        _grant();
        _pay(1e6, "r1");
        vm.prank(owner);
        shield.revokeSession(agent);
        _expectReject(SpendShield.Reason.NoSession);
        _pay(1e6, "r2");
    }

    function test_freeze_blocksAllAgents_unfreezeRestores() public {
        _grant();
        vm.prank(owner);
        shield.setFrozen(true);
        _expectReject(SpendShield.Reason.Frozen);
        _pay(1e6, "r1");

        vm.prank(owner);
        shield.setFrozen(false);
        _pay(1e6, "r1");
    }

    function test_regrant_clearsOldAllowlist() public {
        _grant();
        address[] memory none;
        vm.prank(owner);
        shield.grantSession(agent, _policy(false), none);
        assertFalse(shield.isMerchantAllowed(owner, agent, merchant));
        _expectReject(SpendShield.Reason.MerchantNotAllowed);
        _pay(1e6, "r1");
    }

    function test_setMerchants_addAndRemove() public {
        _grant();
        address[] memory m = new address[](1);
        m[0] = other;
        vm.prank(owner);
        shield.setMerchants(agent, m, true);
        vm.prank(agent);
        shield.pay(owner, other, 1e6, "r1");

        vm.prank(owner);
        shield.setMerchants(agent, m, false);
        vm.prank(agent);
        _expectReject(SpendShield.Reason.MerchantNotAllowed);
        shield.pay(owner, other, 1e6, "r2");
    }

    function test_otherOwnersCannotTouchMySession() public {
        _grant();
        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        shield.revokeSession(agent); // only affects mallory's own (empty) session
        _pay(1e6, "r1");
    }

    // ---------------------------------------------------------------- gasless

    function test_payWithSig_relayerSubmits() public {
        _grant();
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _sign(shield.PAYMENT_TYPEHASH(), agentKey, merchant, 1e6, "g1", deadline);
        vm.prank(relayer);
        shield.payWithSig(owner, agent, merchant, 1e6, "g1", deadline, sig);
        assertEq(token.balanceOf(merchant), 1e6);
    }

    function test_payWithSig_replayRefused() public {
        _grant();
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _sign(shield.PAYMENT_TYPEHASH(), agentKey, merchant, 1e6, "g1", deadline);
        shield.payWithSig(owner, agent, merchant, 1e6, "g1", deadline, sig);
        _expectReject(SpendShield.Reason.RefAlreadyUsed);
        shield.payWithSig(owner, agent, merchant, 1e6, "g1", deadline, sig);
    }

    function test_payWithSig_tamperedAmount() public {
        _grant();
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _sign(shield.PAYMENT_TYPEHASH(), agentKey, merchant, 1e6, "g1", deadline);
        vm.expectRevert(SpendShield.BadSignature.selector);
        shield.payWithSig(owner, agent, merchant, 2e6, "g1", deadline, sig);
    }

    function test_payWithSig_expired() public {
        _grant();
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _sign(shield.PAYMENT_TYPEHASH(), agentKey, merchant, 1e6, "g1", deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(SpendShield.SignatureExpired.selector);
        shield.payWithSig(owner, agent, merchant, 1e6, "g1", deadline, sig);
    }

    function test_payWithSig_revokeVoidsSignature_evenAfterRegrant() public {
        _grant();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(shield.PAYMENT_TYPEHASH(), agentKey, merchant, 1e6, "g1", deadline);
        vm.prank(owner);
        shield.revokeSession(agent);
        _grant(); // new session, new epoch
        vm.expectRevert(SpendShield.BadSignature.selector);
        shield.payWithSig(owner, agent, merchant, 1e6, "g1", deadline, sig);
    }

    function test_payWithSig_wrongSigner() public {
        _grant();
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 structHash = keccak256(abi.encode(shield.PAYMENT_TYPEHASH(), owner, merchant, 1e6, bytes32("g1"), 1, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(strangerKey, keccak256(abi.encodePacked("\x19\x01", shield.domainSeparator(), structHash)));
        vm.expectRevert(SpendShield.BadSignature.selector);
        shield.payWithSig(owner, agent, merchant, 1e6, "g1", deadline, abi.encodePacked(r, s, v));
    }

    // ---------------------------------------------------------------- escalation

    function test_request_overCap_ownerApproves() public {
        _grant();
        vm.prank(agent);
        uint256 id = shield.requestApproval(owner, other, 8e6, "big-1", 1 days);
        assertEq(id, 1);

        vm.prank(owner);
        shield.approveRequest(id);
        assertEq(token.balanceOf(other), 8e6);
        assertEq(shield.balanceOf(owner), 12e6);
        assertTrue(shield.refUsed(owner, "big-1"));
        assertEq(uint8(shield.requestOf(id).status), uint8(SpendShield.RequestStatus.Approved));
        // Approved payments don't eat the agent's own budget.
        assertEq(shield.remaining(owner, agent), BUDGET);
    }

    function test_request_reject() public {
        _grant();
        vm.prank(agent);
        uint256 id = shield.requestApproval(owner, other, 8e6, "big-1", 1 days);
        vm.prank(owner);
        shield.rejectRequest(id);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendShield.RequestNotPending.selector, id));
        shield.approveRequest(id);
        assertEq(token.balanceOf(other), 0);
    }

    function test_request_onlyOwnerSettles() public {
        _grant();
        vm.prank(agent);
        uint256 id = shield.requestApproval(owner, other, 8e6, "big-1", 1 days);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendShield.NotRequestOwner.selector, id));
        shield.approveRequest(id);
    }

    function test_request_expires() public {
        _grant();
        vm.prank(agent);
        uint256 id = shield.requestApproval(owner, other, 8e6, "big-1", 1 hours);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendShield.RequestExpired.selector, id));
        shield.approveRequest(id);
    }

    function test_request_needsSession_andUniqueRef() public {
        vm.prank(agent);
        _expectReject(SpendShield.Reason.NoSession);
        shield.requestApproval(owner, other, 8e6, "big-1", 1 days);

        _grant();
        vm.prank(agent);
        shield.requestApproval(owner, other, 8e6, "big-1", 1 days);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendShield.RefAlreadyRequested.selector, bytes32("big-1")));
        shield.requestApproval(owner, other, 8e6, "big-1", 1 days);
    }

    function test_requestWithSig() public {
        _grant();
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _sign(shield.REQUEST_TYPEHASH(), agentKey, other, 8e6, "big-1", deadline);
        vm.prank(relayer);
        uint256 id = shield.requestApprovalWithSig(owner, agent, other, 8e6, "big-1", 1 days, deadline, sig);
        assertEq(shield.requestOf(id).agent, agent);
    }

    function test_paymentSigCantBeUsedAsRequest() public {
        _grant();
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _sign(shield.PAYMENT_TYPEHASH(), agentKey, other, 8e6, "big-1", deadline);
        vm.expectRevert(SpendShield.BadSignature.selector);
        shield.requestApprovalWithSig(owner, agent, other, 8e6, "big-1", 1 days, deadline, sig);
    }

    // ---------------------------------------------------------------- invariants (fuzz)

    /// Whatever the agent tries, it never spends more than the budget inside one period,
    /// and `check` always predicts the outcome of `pay`.
    function testFuzz_neverExceedsBudget_andCheckMatchesPay(uint256[8] calldata amounts, uint32[8] calldata gaps)
        public
    {
        _grant();
        for (uint256 i; i < 8; ++i) {
            vm.warp(block.timestamp + (gaps[i] % (DAY / 2)));
            uint256 amount = amounts[i] % (PER_TX + 2);
            bytes32 ref = bytes32(i + 1);
            SpendShield.Reason r = shield.check(owner, agent, merchant, amount, ref);
            uint256 before = token.balanceOf(merchant);

            vm.prank(agent);
            (bool ok,) = address(shield).call(abi.encodeCall(SpendShield.pay, (owner, merchant, amount, ref)));

            assertEq(ok, r == SpendShield.Reason.OK, "check() disagrees with pay()");
            if (ok) assertEq(token.balanceOf(merchant) - before, amount);
            assertLe(shield.sessionOf(owner, agent).spentInPeriod, BUDGET);
        }
    }
}
