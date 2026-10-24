import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { IOU_TYPES, iouDigest, kohakuDomain, net, type IOU } from "../src/index.ts";

interface VectorIou {
  buyer: number;
  seller: number;
  amount: number;
  token: Address;
  jobHash: Hex;
  quoteHash: Hex;
  epoch: number;
  nonce: number;
  signature: Hex;
  digest: Hex;
}

const v = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const vectors: VectorIou[] = JSON.parse(v.iousJson);
const domain = kohakuDomain(Number(v.chainId), v.clearingHouse);

const toIou = (x: VectorIou): IOU => ({
  buyer: BigInt(x.buyer),
  seller: BigInt(x.seller),
  amount: BigInt(x.amount),
  token: x.token,
  jobHash: x.jobHash,
  quoteHash: x.quoteHash,
  epoch: BigInt(x.epoch),
  nonce: BigInt(x.nonce),
});

describe("TypeScript matches the clearing house contract", () => {
  it("computes the same EIP-712 digest for every IOU", () => {
    for (const x of vectors) {
      expect(iouDigest(domain, toIou(x))).toBe(x.digest);
    }
  });

  it("recovers a signer from each contract-signed IOU", async () => {
    for (const x of vectors) {
      const signer = await recoverTypedDataAddress({
        domain,
        types: IOU_TYPES,
        primaryType: "IOU",
        message: toIou(x),
        signature: x.signature,
      });
      expect(signer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("reproduces the on-chain IOU-set and positions commitments", () => {
    // shuffle to prove the result does not depend on arrival order
    const shuffled = [...vectors].reverse();
    const result = net(shuffled.map((x) => ({ ...toIou(x), digest: x.digest })));
    expect(result.iouSetHash).toBe(v.iouSetHash);
    expect(result.positionsHash).toBe(v.positionsHash);
    expect(result.stats.grossVolume).toBe(BigInt(v.grossVolume));
    expect(result.stats.netVolume).toBe(BigInt(v.netVolume));
  });
});
