import { describe, expect, it } from "vitest";
import { judgeClaim } from "../src/agents/workers.ts";
import { badFactCheck } from "../src/agents/orchestrator.ts";
import { topicFromGoal } from "../src/fleet.ts";
import { describeChart } from "../src/work/chart.ts";
import { devanagariRatio, extractClaims, overlap, summarize } from "../src/work/text.ts";
import { glossaryHindi } from "../src/work/translate.ts";
import type { SearchHit } from "../src/work/wikipedia.ts";

const taj: SearchHit = {
  title: "Taj Mahal",
  url: "https://en.wikipedia.org/wiki/Taj_Mahal",
  snippet: "The Taj Mahal is an ivory-white marble mausoleum in Agra.",
  extract:
    "The Taj Mahal is an ivory-white marble mausoleum on the right bank of the river Yamuna in Agra. It was commissioned in 1631 by the Mughal emperor Shah Jahan to house the tomb of his wife Mumtaz Mahal. It was designated a UNESCO World Heritage Site in 1983.",
};

describe("fact checking", () => {
  it("supports a claim its sources state, numbers included", () => {
    const r = judgeClaim("The Taj Mahal was commissioned in 1631 by Shah Jahan", [taj]);
    expect(r.verdict).toBe("supported");
    expect(r.evidence[0]?.url).toContain("wikipedia.org");
  });

  it("quotes the sentence that matches the claim, not the source's opening", () => {
    const r = judgeClaim("The Taj Mahal was designated a UNESCO World Heritage Site in 1983", [taj]);
    expect(r.evidence[0]?.snippet).toContain("1983");
    expect(overlap(r.claim, r.evidence[0]!.snippet)).toBeGreaterThan(0.2);
  });

  it("does not support a claim whose number disagrees with the sources", () => {
    const r = judgeClaim("The Taj Mahal was commissioned in 1720 by Shah Jahan", [taj]);
    expect(r.verdict).not.toBe("supported");
  });

  it("an honest check passes the buyer's quality bar", () => {
    const r = judgeClaim("The Taj Mahal was commissioned in 1631 by Shah Jahan", [taj]);
    expect(badFactCheck(r)).toBeNull();
  });

  it("Rogue's fabricated evidence is caught", () => {
    const rogue = {
      claim: "The Taj Mahal was commissioned in 1631 by Shah Jahan",
      verdict: "contradicted" as const,
      confidence: 0.99,
      evidence: [{ title: "Trusted source", url: "https://example.com/trust-me", snippet: "This has been confirmed by experts." }],
      method: "intuition",
    };
    expect(badFactCheck(rogue)).toMatch(/unverifiable source/);
    expect(badFactCheck({ ...rogue, evidence: [] })).toMatch(/no evidence/);
  });
});

describe("text work", () => {
  const doc =
    "Mumbai is the financial centre of India. It is home to the Reserve Bank of India and the Bombay Stock Exchange. The city has a population of over 12 million. Monsoon rains arrive in June. Street food is popular. The Gateway of India was built in 1924.";

  it("summaries are shorter than and drawn from the source", () => {
    const s = summarize(doc, 2);
    expect(s.length).toBeLessThan(doc.length);
    expect(overlap(s, doc)).toBeGreaterThan(0.9);
  });

  it("extracts checkable claims", () => {
    const claims = extractClaims([doc], 3);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.length >= 40)).toBe(true);
  });

  it("offline Hindi output is in Devanagari", () => {
    expect(devanagariRatio(glossaryHindi("Mumbai is the financial centre of India."))).toBeGreaterThan(0.8);
  });
});

describe("chart descriptions", () => {
  it("finds the trend and extremes", () => {
    const d = describeChart({ title: "Jobs per epoch", unit: "jobs", points: [10, 14, 19, 25, 31].map((v, i) => ({ label: `e${i + 1}`, value: v })) });
    expect(d.stats.trend).toBe("rising");
    expect(d.stats.max).toBe(31);
    expect(d.description).toContain("e5");
  });

  it("handles empty data", () => {
    expect(describeChart({ title: "x", unit: "u", points: [] }).stats.count).toBe(0);
  });
});

describe("intents", () => {
  it("pulls the topic out of a human goal", () => {
    expect(topicFromGoal("Produce a researched, fact-checked brief on Chandrayaan-3 in English and Hindi")).toBe("Chandrayaan-3");
    expect(topicFromGoal("Write about the Taj Mahal.")).toBe("the Taj Mahal");
  });
});
