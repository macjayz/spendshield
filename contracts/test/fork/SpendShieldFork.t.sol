// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpendShield} from "../../src/SpendShield.sol";
import {Signing} from "../Signing.sol";

interface ITUSD8F is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice SpendShield against the REAL tUSD8 on a local fork of Aevum testnet.
///         make test-fork   (or: forge test --match-path 'test/fork/*' --fork-url aevum)
contract SpendShieldForkTest is Test {
    ITUSD8F constant TUSD8 = ITUSD8F(0x456569838f1d43009A91ebA4263147Afd7233483);

    SpendShield shield;
    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address merchant = makeAddr("merchant");
    address relayer = makeAddr("relayer");

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        shield = new SpendShield(TUSD8);
        deal(address(TUSD8), owner, 10e6);
    }

    function test_realTusd8_gaslessDeposit_thenGaslessAgentPayment() public {
        assertEq(block.chainid, 44005, "run with --fork-url aevum");
        _gaslessDeposit(5e6);
        assertEq(shield.balanceOf(owner), 5e6);

        _grant(); // 1 tUSD8 per payment, 2 per day, one merchant
        _agentPaysGasless(1e6, "api-call-1");

        assertEq(TUSD8.balanceOf(merchant), 1e6);
        assertEq(TUSD8.balanceOf(address(shield)), 4e6);
        assertEq(shield.remaining(owner, agent), 1e6);
    }

    function _gaslessDeposit(uint256 amount) internal {
        bytes32 nonce = keccak256("fork-deposit");
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
            vm, ownerKey, TUSD8.DOMAIN_SEPARATOR(), Signing.Auth(owner, address(shield), amount, 0, validBefore, nonce)
        );
        vm.prank(relayer);
        shield.depositWithAuthorization(owner, amount, 0, validBefore, nonce, v, r, s);
    }

    function _grant() internal {
        address[] memory m = new address[](1);
        m[0] = merchant;
        vm.prank(owner);
        shield.grantSession(
            agent,
            SpendShield.Policy({
                maxPerPayment: 1e6,
                budgetPerPeriod: 2e6,
                period: 1 days,
                expiresAt: uint64(block.timestamp + 7 days),
                anyMerchant: false
            }),
            m
        );
    }

    function _agentPaysGasless(uint256 amount, bytes32 ref) internal {
        uint256 deadline = block.timestamp + 10 minutes;
        uint32 epoch = shield.sessionOf(owner, agent).epoch;
        bytes32 structHash =
            keccak256(abi.encode(shield.PAYMENT_TYPEHASH(), owner, merchant, amount, ref, epoch, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(agentKey, keccak256(abi.encodePacked("\x19\x01", shield.domainSeparator(), structHash)));
        vm.prank(relayer);
        shield.payWithSig(owner, agent, merchant, amount, ref, deadline, abi.encodePacked(r, s, v));
    }
}
