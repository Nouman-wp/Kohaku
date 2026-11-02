import { describe, expect, it } from "vitest";
import { hashTypedData, recoverAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hspTypedDataDomain } from "../src/shop/book.ts";

// the shape prepare_payment returns for Circle's USDC on Ethereum Sepolia (eip3009)
const eip712 = {
  domain: { chainId: "0xaa36a7", name: "USDC", verifyingContract: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", version: "2" },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
};
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const message = {
  from: account.address,
  to: "0xa73C17d67d6f5AF6E9D2F2d49ba93A2afB3Ee46b",
  value: "1000401",
  validAfter: "0",
  validBefore: "1793620309",
  nonce: "0xd0c4df2b23e8a48d914de8b73a8109fbe6490dcf4c3594c1701651431d4c3b4b",
};
const { EIP712Domain: _, ...types } = eip712.types;
// what the token contract checks: the domain hashed with HSP's own EIP712Domain type, chainId included
const contractDigest = hashTypedData({ domain: eip712.domain, types: eip712.types, primaryType: "TransferWithAuthorization", message } as never);

describe("signing HSP's eip712", () => {
  it("reads the hex chainId as a number", () => {
    expect(hspTypedDataDomain(eip712.domain).chainId).toBe(11155111);
    expect(hspTypedDataDomain({ chainId: 133 }).chainId).toBe(133);
  });

  it("signs what the token contract verifies", async () => {
    const signature = (await account.signTypedData({ domain: hspTypedDataDomain(eip712.domain), types, primaryType: "TransferWithAuthorization", message } as never)) as Hex;
    expect(await recoverAddress({ hash: contractDigest, signature })).toBe(account.address);
  });

  it("signing the domain as sent would leave the chain out", async () => {
    const signature = (await account.signTypedData({ domain: eip712.domain, types, primaryType: "TransferWithAuthorization", message } as never)) as Hex;
    expect(await recoverAddress({ hash: contractDigest, signature })).not.toBe(account.address);
  });
});
