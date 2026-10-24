import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { compression, net, scoreReputation, emptyInputs, usd, formatUnits, type NettableIou } from "../src/index.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomIous(seed: number, count: number, agents = 6): NettableIou[] {
  const r = rng(seed);
  const nonces = new Map<number, bigint>();
  const out: NettableIou[] = [];
  for (let i = 0; i < count; i++) {
    const buyer = 1 + Math.floor(r() * agents);
    let seller = 1 + Math.floor(r() * agents);
    if (seller === buyer) seller = (seller % agents) + 1;
    const nonce = (nonces.get(buyer) ?? 0n) + 1n;
    nonces.set(buyer, nonce);
    out.push({
      buyer: BigInt(buyer),
      seller: BigInt(seller),
      amount: BigInt(1 + Math.floor(r() * 50_000)),
      nonce,
      digest: keccak256(toHex(`iou-${seed}-${i}`)),
    });
  }
  return out;
}

describe("netting", () => {
  it("net positions always sum to zero (randomised)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const result = net(randomIous(seed, 1 + (seed % 120)));
      const sum = result.positions.reduce((acc, p) => acc + p.net, 0n);
      expect(sum).toBe(0n);
      const pos = result.positions.filter((p) => p.net > 0n).reduce((a, p) => a + p.net, 0n);
      expect(pos).toBe(result.stats.netVolume);
      expect(result.stats.netVolume <= result.stats.grossVolume).toBe(true);
    }
  });

  it("each position equals sales minus purchases", () => {
    const ious = randomIous(42, 200);
    const result = net(ious);
    for (const p of result.positions) {
      const sold = ious.filter((i) => i.seller === p.agentId).reduce((a, i) => a + i.amount, 0n);
      const bought = ious.filter((i) => i.buyer === p.agentId).reduce((a, i) => a + i.amount, 0n);
      expect(p.net).toBe(sold - bought);
      expect(p.credit).toBe(sold);
      expect(p.debit).toBe(bought);
    }
  });

  it("is independent of arrival order", () => {
    const ious = randomIous(7, 80);
    const a = net(ious);
    const b = net([...ious].reverse());
    expect(a.iouSetHash).toBe(b.iouSetHash);
    expect(a.positionsHash).toBe(b.positionsHash);
  });

  it("rejects duplicate (buyer, nonce)", () => {
    const ious = randomIous(9, 10);
    expect(() => net([...ious, { ...ious[0]!, digest: keccak256(toHex("dupe")) }])).toThrow(/duplicate/);
  });

  it("voided IOUs never affect positions", () => {
    const ious = randomIous(11, 50);
    const voided = ious.filter((_, i) => i % 5 === 0);
    const kept = ious.filter((_, i) => i % 5 !== 0);
    const result = net(kept);
    for (const v of voided) {
      // removing a voided IOU must not leave a trace in the IOU-set commitment
      expect(result.ordered.find((o) => o.digest === v.digest)).toBeUndefined();
    }
  });

  it("an epoch with one IOU honestly shows no saving", () => {
    const s = compression(1, 400n, 400n, 1, 1);
    expect(s.transfersAvoided).toBe(0);
    expect(s.transferReduction).toBe(0);
  });

  it("very many tiny IOUs keep exact integer totals", () => {
    const tiny: NettableIou[] = [];
    for (let i = 0; i < 20_000; i++) {
      tiny.push({ buyer: BigInt(1 + (i % 7)), seller: BigInt(1 + ((i + 3) % 7)), amount: 1n, nonce: BigInt(i + 1), digest: keccak256(toHex(i)) });
    }
    const result = net(tiny);
    expect(result.stats.grossVolume).toBe(20_000n);
    expect(result.positions.reduce((a, p) => a + p.net, 0n)).toBe(0n);
  });
});

describe("reputation", () => {
  it("a fresh agent starts high but below a proven one", () => {
    const fresh = scoreReputation(emptyInputs()).score;
    const proven = scoreReputation({ ...emptyInputs(), completed: 400, settledOnTime: 40 }).score;
    expect(fresh).toBeLessThan(proven);
    expect(fresh).toBeGreaterThan(800);
  });

  it("one lost dispute drops a young seller below 700", () => {
    const s = scoreReputation({ ...emptyInputs(), completed: 5, disputesLost: 1 }).score;
    expect(s).toBeLessThan(700);
  });

  it("defaults and frivolous disputes cost reputation", () => {
    const base = scoreReputation({ ...emptyInputs(), completed: 50, settledOnTime: 10 }).score;
    expect(scoreReputation({ ...emptyInputs(), completed: 50, settledOnTime: 10, defaults: 1 }).score).toBeLessThan(base);
    expect(scoreReputation({ ...emptyInputs(), completed: 50, settledOnTime: 10, frivolousDisputes: 2 }).score).toBeLessThan(base);
  });
});

describe("money", () => {
  it("parses and formats without floating point", () => {
    expect(usd("0.0004")).toBe(400n);
    expect(usd("20")).toBe(20_000_000n);
    expect(formatUnits(400n, 2)).toBe("0.0004");
    expect(formatUnits(20_000_000n)).toBe("20.00");
  });
});
