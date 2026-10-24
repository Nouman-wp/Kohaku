import {
  hashTypedData,
  hashStruct,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";

/**
 * Every Kohaku message is EIP-712 typed data under the clearing house's domain, so a
 * signature made for one deployment (chain + contract) is useless on any other.
 * The IOU type is byte-for-byte the struct the clearing house verifies on chain.
 */
export const DOMAIN_NAME = "Kohaku Clearing House";
export const DOMAIN_VERSION = "1";

export function kohakuDomain(chainId: number, clearingHouse: Address): TypedDataDomain {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: clearingHouse };
}

export const IOU_TYPES = {
  IOU: [
    { name: "buyer", type: "uint256" },
    { name: "seller", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "token", type: "address" },
    { name: "jobHash", type: "bytes32" },
    { name: "quoteHash", type: "bytes32" },
    { name: "epoch", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** A seller's binding offer: price, job and expiry. The quote wins over later price changes. */
export const QUOTE_TYPES = {
  Quote: [
    { name: "seller", type: "uint256" },
    { name: "buyer", type: "uint256" },
    { name: "service", type: "string" },
    { name: "price", type: "uint256" },
    { name: "token", type: "address" },
    { name: "jobHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "quoteNonce", type: "uint64" },
  ],
} as const;

/** The seller's signed statement that it delivered `resultHash` for the job. */
export const DELIVERY_TYPES = {
  Delivery: [
    { name: "seller", type: "uint256" },
    { name: "jobHash", type: "bytes32" },
    { name: "iouDigest", type: "bytes32" },
    { name: "resultHash", type: "bytes32" },
    { name: "deliveredAt", type: "uint64" },
  ],
} as const;

/**
 * AP2-style Intent Mandate: a human operator authorises a buyer agent to spend up to a
 * budget for a goal, before a deadline, inside limits. Empty arrays mean "no restriction".
 */
export const INTENT_TYPES = {
  IntentMandate: [
    { name: "operator", type: "address" },
    { name: "buyer", type: "uint256" },
    { name: "goal", type: "string" },
    { name: "budget", type: "uint256" },
    { name: "perJobCap", type: "uint256" },
    { name: "minSellerReputation", type: "uint16" },
    { name: "allowedServices", type: "string[]" },
    { name: "allowedSellers", type: "uint256[]" },
    { name: "notBefore", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export const REVOCATION_TYPES = {
  IntentRevocation: [
    { name: "intentHash", type: "bytes32" },
    { name: "revokedAt", type: "uint64" },
  ],
} as const;

/** A buyer's challenge of a delivered job, filed inside the challenge window. */
export const DISPUTE_TYPES = {
  Dispute: [
    { name: "buyer", type: "uint256" },
    { name: "jobHash", type: "bytes32" },
    { name: "iouDigest", type: "bytes32" },
    { name: "reason", type: "string" },
    { name: "filedAt", type: "uint64" },
  ],
} as const;

/** A validator's ruling. upheld = the seller's work failed and the IOU is voided. */
export const VERDICT_TYPES = {
  Verdict: [
    { name: "disputeHash", type: "bytes32" },
    { name: "validator", type: "uint256" },
    { name: "upheld", type: "bool" },
    { name: "reasoning", type: "string" },
    { name: "decidedAt", type: "uint64" },
  ],
} as const;

// ------------------------------------------------------------------ message shapes

export interface IOU {
  buyer: bigint;
  seller: bigint;
  amount: bigint;
  token: Address;
  jobHash: Hex;
  quoteHash: Hex;
  epoch: bigint;
  nonce: bigint;
}

export interface Quote {
  seller: bigint;
  buyer: bigint;
  service: string;
  price: bigint;
  token: Address;
  jobHash: Hex;
  expiry: bigint;
  quoteNonce: bigint;
}

export interface Delivery {
  seller: bigint;
  jobHash: Hex;
  iouDigest: Hex;
  resultHash: Hex;
  deliveredAt: bigint;
}

export interface IntentMandate {
  operator: Address;
  buyer: bigint;
  goal: string;
  budget: bigint;
  perJobCap: bigint;
  minSellerReputation: number;
  allowedServices: string[];
  allowedSellers: bigint[];
  notBefore: bigint;
  deadline: bigint;
  nonce: bigint;
}

export interface IntentRevocation {
  intentHash: Hex;
  revokedAt: bigint;
}

export interface Dispute {
  buyer: bigint;
  jobHash: Hex;
  iouDigest: Hex;
  reason: string;
  filedAt: bigint;
}

export interface Verdict {
  disputeHash: Hex;
  validator: bigint;
  upheld: boolean;
  reasoning: string;
  decidedAt: bigint;
}

// ------------------------------------------------------------------ digests

export function iouDigest(domain: TypedDataDomain, iou: IOU): Hex {
  return hashTypedData({ domain, types: IOU_TYPES, primaryType: "IOU", message: iou });
}

export function quoteDigest(domain: TypedDataDomain, quote: Quote): Hex {
  return hashTypedData({ domain, types: QUOTE_TYPES, primaryType: "Quote", message: quote });
}

export function deliveryDigest(domain: TypedDataDomain, d: Delivery): Hex {
  return hashTypedData({ domain, types: DELIVERY_TYPES, primaryType: "Delivery", message: d });
}

export function intentDigest(domain: TypedDataDomain, intent: IntentMandate): Hex {
  return hashTypedData({ domain, types: INTENT_TYPES, primaryType: "IntentMandate", message: intent });
}

export function revocationDigest(domain: TypedDataDomain, r: IntentRevocation): Hex {
  return hashTypedData({ domain, types: REVOCATION_TYPES, primaryType: "IntentRevocation", message: r });
}

export function disputeDigest(domain: TypedDataDomain, d: Dispute): Hex {
  return hashTypedData({ domain, types: DISPUTE_TYPES, primaryType: "Dispute", message: d });
}

export function verdictDigest(domain: TypedDataDomain, v: Verdict): Hex {
  return hashTypedData({ domain, types: VERDICT_TYPES, primaryType: "Verdict", message: v });
}

/** Struct hash without the domain, handy for logs. */
export function iouStructHash(iou: IOU): Hex {
  return hashStruct({ data: iou, types: IOU_TYPES, primaryType: "IOU" });
}

// ------------------------------------------------------------------ job hashing

/** Deterministic JSON: object keys sorted, bigints as decimal strings, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortValue(val);
    }
    return out;
  }
  return v;
}

export function hashJson(value: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(value)));
}

export interface JobSpec {
  buyer: string; // agent id as decimal string
  seller: string;
  service: string;
  input: unknown;
  requestedAt: number; // unix ms
  salt: string;
}

export function jobHash(spec: JobSpec): Hex {
  return hashJson(spec);
}
