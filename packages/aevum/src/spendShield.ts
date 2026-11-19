import type { Address, Hex } from "viem";

export { spendShieldAbi } from "./spendShieldAbi";

/** Mirrors `SpendShield.Reason`. Index = the uint8 the contract returns. */
export const REASONS = [
  "OK",
  "Frozen",
  "NoSession",
  "Expired",
  "ZeroAmount",
  "OverPerPaymentCap",
  "MerchantNotAllowed",
  "OverPeriodBudget",
  "RefAlreadyUsed",
  "InsufficientBalance",
] as const;
export type Reason = (typeof REASONS)[number];

/** One sentence per reason, for logs, agents and the UI. */
export const REASON_TEXT: Record<Reason, string> = {
  OK: "Allowed by the policy.",
  Frozen: "The owner froze all agent spending.",
  NoSession: "This agent has no active session (never granted, or revoked).",
  Expired: "The agent's session has expired.",
  ZeroAmount: "The amount must be more than zero.",
  OverPerPaymentCap: "Over the agent's per-payment cap. Needs the owner's approval.",
  MerchantNotAllowed: "This merchant isn't on the agent's allowlist. Needs the owner's approval.",
  OverPeriodBudget: "Over the agent's budget for this period. Wait for the next period or ask the owner.",
  RefAlreadyUsed: "This payment reference was already paid. Not paying twice.",
  InsufficientBalance: "The owner's vault doesn't hold enough tUSD8.",
};

export function reasonOf(code: number | bigint): Reason {
  return REASONS[Number(code)] ?? "OK";
}

/** Reasons where asking the owner (requestApproval) makes sense. */
export function needsApproval(r: Reason): boolean {
  return r === "OverPerPaymentCap" || r === "MerchantNotAllowed" || r === "OverPeriodBudget";
}

export function spendShieldDomain(chainId: number, verifyingContract: Address) {
  return { name: "SpendShield", version: "1", chainId, verifyingContract } as const;
}

const fields = [
  { name: "owner", type: "address" },
  { name: "merchant", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "ref", type: "bytes32" },
  { name: "epoch", type: "uint32" },
  { name: "deadline", type: "uint256" },
] as const;

export interface AgentMessage {
  owner: Address;
  merchant: Address;
  amount: bigint;
  ref: Hex;
  /** `sessionOf(owner, agent).epoch`. A revoke bumps it and voids the signature. */
  epoch: number;
  deadline: bigint;
}

/** Typed data an agent signs so a relayer can submit `payWithSig`. */
export function agentPaymentTypedData(chainId: number, shield: Address, message: AgentMessage) {
  return {
    domain: spendShieldDomain(chainId, shield),
    types: { AgentPayment: fields },
    primaryType: "AgentPayment" as const,
    message,
  };
}

/** Typed data an agent signs so a relayer can submit `requestApprovalWithSig`. */
export function approvalRequestTypedData(chainId: number, shield: Address, message: AgentMessage) {
  return {
    domain: spendShieldDomain(chainId, shield),
    types: { ApprovalRequest: fields },
    primaryType: "ApprovalRequest" as const,
    message,
  };
}

export const PERIODS = { hour: 3600, day: 86400, week: 604800 } as const;
