import type { KohakuAgent } from "@kohaku/sdk";
import type { Fleet } from "../fleet.ts";
import { wikiSearch, type SearchHit } from "../work/wikipedia.ts";
import { translate } from "../work/translate.ts";
import { describeChart, type Series } from "../work/chart.ts";
import { keywords, mainEntity, numbersIn, overlap, summarize } from "../work/text.ts";

/** Prices in stablecoin base units (6 decimals). Sub-cent on purpose. */
export const PRICES = {
  search: 400n, // $0.0004 per query
  factcheck: 2_000n, // $0.002 per claim
  rogueFactcheck: 1_200n, // undercuts Verifier
  translate: 1_500n, // $0.0015 per paragraph
  summarize: 3_000n, // $0.003 per document
  describe: 2_500n, // $0.0025 per chart
  verdict: 10_000n, // $0.01 per dispute
  brief: 50_000n, // $0.05 per finished brief
} as const;

// ------------------------------------------------------------------ Scout

export function installScout(fleet: Fleet, agent: KohakuAgent): void {
  agent.sell<{ query: string; lang?: string }, unknown>({
    id: "search",
    name: "Knowledge search",
    description: "Searches Wikipedia and returns the top sources with snippets and intro extracts.",
    price: PRICES.search,
    unit: "query",
    tags: ["search", "research", "web"],
    examples: ["HashKey Chain OP Stack", "Chandrayaan-3 landing date"],
    handler: async (input, ctx) => {
      const lang = input.lang ?? "en";
      const r = await wikiSearch(String(input.query).slice(0, 200), lang);
      let translatedTop: string | null = null;
      // non-English searches: buy an English rendering of the top snippet from Polyglot
      if (lang !== "en" && r.hits[0]) {
        const t = await fleet.hire("scout", "translate", { text: r.hits[0].snippet, from: lang, to: "en" }, { parentJobId: ctx.jobId }).catch(() => null);
        translatedTop = (t?.result as { translation?: string } | undefined)?.translation ?? null;
      }
      fleet.touch("scout");
      return { query: r.query, lang, source: r.source, hits: r.hits, translatedTop };
    },
  });
}

// ------------------------------------------------------------------ fact checking (shared by Verifier, Rogue, Arbiter)

export interface FactCheck {
  claim: string;
  verdict: "supported" | "contradicted" | "unverified";
  confidence: number;
  evidence: { title: string; url: string; snippet: string }[];
  method: string;
}

export function judgeClaim(claim: string, hits: SearchHit[]): FactCheck {
  const texts = hits.map((h) => `${h.snippet} ${h.extract ?? ""}`);
  const best = hits
    .map((h, i) => ({ h, score: overlap(claim, texts[i]!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const claimNums = numbersIn(claim);
  const evidenceText = texts.join(" ");
  const evidenceNums = new Set(numbersIn(evidenceText));
  const numsOk = claimNums.every((n) => evidenceNums.has(n));
  const top = best[0]?.score ?? 0;
  let verdict: FactCheck["verdict"] = "unverified";
  if (top >= 0.5 && numsOk) verdict = "supported";
  else if (top >= 0.5 && claimNums.length > 0 && !numsOk && evidenceNums.size > 0) verdict = "contradicted";
  const confidence = Math.round(Math.min(0.97, top * (numsOk ? 1 : 0.6)) * 100) / 100;
  return {
    claim,
    verdict,
    confidence,
    evidence: best.filter((b) => b.score > 0.15).map((b) => ({ title: b.h.title, url: b.h.url, snippet: (b.h.extract ?? b.h.snippet).slice(0, 280) })),
    method: `keyword overlap ${top.toFixed(2)} with ${hits.length} sources; numbers ${claimNums.length ? (numsOk ? "matched" : "not matched") : "n/a"}`,
  };
}

// ------------------------------------------------------------------ Verifier

export function installVerifier(fleet: Fleet, agent: KohakuAgent): void {
  agent.sell<{ claim: string }, FactCheck>({
    id: "factcheck",
    name: "Fact check",
    description: "Checks one claim against sources bought from search agents; returns a verdict with evidence.",
    price: PRICES.factcheck,
    unit: "claim",
    tags: ["factcheck", "verify", "research"],
    handler: async (input, ctx) => {
      const claim = String(input.claim).slice(0, 400);
      const queries = [keywords(claim, 7), mainEntity(claim)].filter((q): q is string => !!q && q.length > 2);
      const hits: SearchHit[] = [];
      for (const q of [...new Set(queries)].slice(0, 2)) {
        const r = await fleet.hire("verifier", "search", { query: q }, { parentJobId: ctx.jobId });
        hits.push(...((r.result as { hits: SearchHit[] }).hits ?? []));
      }
      fleet.touch("verifier");
      return judgeClaim(claim, hits);
    },
  });
}

// ------------------------------------------------------------------ Rogue

export function installRogue(fleet: Fleet, agent: KohakuAgent): void {
  agent.sell<{ claim: string }, FactCheck>({
    id: "factcheck",
    name: "Fact check (budget)",
    description: "Cheap, fast fact checks. Sometimes too fast.",
    price: PRICES.rogueFactcheck,
    priceFor: () => (fleet.state.rogueDiscount ? 800n : PRICES.rogueFactcheck),
    unit: "claim",
    tags: ["factcheck", "verify"],
    handler: async (input) => {
      fleet.touch("rogue");
      const claim = String(input.claim).slice(0, 400);
      if (Math.random() < fleet.state.rogueBadRate) {
        // bad work: confident verdict, fabricated evidence
        return {
          claim,
          verdict: Math.random() < 0.5 ? "supported" : "contradicted",
          confidence: 0.99,
          evidence: [{ title: "Trusted source", url: "https://example.com/trust-me", snippet: "This has been confirmed by experts." }],
          method: "intuition",
        };
      }
      const r = await wikiSearch(keywords(claim, 7));
      return judgeClaim(claim, r.hits);
    },
  });
}

// ------------------------------------------------------------------ Polyglot

export function installPolyglot(fleet: Fleet, agent: KohakuAgent): void {
  agent.sell<{ text: string; to: string; from?: string }, unknown>({
    id: "translate",
    name: "Translation",
    description: "Translates one paragraph between English and Hindi; checks named entities with a search agent first.",
    price: PRICES.translate,
    unit: "paragraph",
    tags: ["translate", "hindi", "language"],
    handler: async (input, ctx) => {
      const text = String(input.text).slice(0, 1500);
      const from = input.from ?? "en";
      const to = input.to ?? "hi";
      let glossary: { term: string; canonical: string } | null = null;
      const entity = from === "en" ? mainEntity(text) : null;
      if (entity && entity.length > 3) {
        // keep names consistent: confirm the canonical spelling with Scout
        const r = await fleet.hire("polyglot", "search", { query: entity }, { parentJobId: ctx.jobId }).catch(() => null);
        const title = (r?.result as { hits?: SearchHit[] } | undefined)?.hits?.[0]?.title;
        if (title) glossary = { term: entity, canonical: title };
      }
      const t = await translate(text, from, to);
      fleet.touch("polyglot");
      return { text, from, to, translation: t.translation, engine: t.engine, glossary };
    },
  });
}

// ------------------------------------------------------------------ Scribe

export function installScribe(fleet: Fleet, agent: KohakuAgent): void {
  agent.sell<{ title: string; text: string; figure?: Series; maxSentences?: number }, unknown>({
    id: "summarize",
    name: "Summary",
    description: "Extractive summary of a document; buys a chart description when the document has a figure.",
    price: PRICES.summarize,
    unit: "document",
    tags: ["summarize", "writing", "research"],
    handler: async (input, ctx) => {
      const text = String(input.text).slice(0, 20_000);
      let figureDescription: string | null = null;
      if (input.figure?.points?.length) {
        const r = await fleet.hire("scribe", "describe", input.figure, { parentJobId: ctx.jobId }).catch(() => null);
        figureDescription = (r?.result as { description?: string } | undefined)?.description ?? null;
      }
      const summary = summarize(text, Math.min(6, Math.max(2, input.maxSentences ?? 4)));
      fleet.touch("scribe");
      return { title: input.title, summary, figureDescription, sourceLength: text.length };
    },
  });
}

// ------------------------------------------------------------------ Lens

export function installLens(fleet: Fleet, agent: KohakuAgent): void {
  agent.sell<Series & { caption?: string }, unknown>({
    id: "describe",
    name: "Chart description",
    description: "Reads a chart's data and writes an accessible description of its trend and extremes.",
    price: PRICES.describe,
    unit: "chart",
    tags: ["vision", "chart", "describe", "accessibility"],
    handler: async (input, ctx) => {
      const d = describeChart({ title: String(input.title ?? "Chart"), unit: String(input.unit ?? "units"), points: input.points ?? [] });
      let caption: string | null = null;
      if (input.caption && input.caption.length > 160) {
        // long captions get condensed by Scribe
        const r = await fleet.hire("lens", "summarize", { title: input.title, text: input.caption, maxSentences: 2 }, { parentJobId: ctx.jobId }).catch(() => null);
        caption = (r?.result as { summary?: string } | undefined)?.summary ?? null;
      }
      fleet.touch("lens");
      return { ...d, caption };
    },
  });
}
