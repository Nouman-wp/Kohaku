import type { KohakuAgent } from "@kohaku/sdk";
import type { Fleet } from "../fleet.ts";
import { PHONES, STORES, brandsIn, phone, redeem, store, type PhoneModel, type StoreDef, type StoreSlug } from "../shop/catalogue.ts";
import { fetchSpecs, type SpecSheet } from "../shop/specs.ts";
import { round2, type ShopOffer, type ShopOption } from "../shop/book.ts";

/** Prices in stablecoin base units (6 decimals). */
export const SHOP_PRICES = {
  shop: 50_000n, // $0.05 per shopping request
  compare: 4_000n, // $0.004 per comparison
  coupons: 3_000n, // $0.003 per coupon hunt
  specs: 600n, // $0.0006 per spec sheet
  quote: 500n, // $0.0005 per store quote
  promos: 500n, // $0.0005 per promo list
  redeem: 500n, // $0.0005 per coupon check
} as const;

interface Quote {
  store: StoreSlug;
  storeName: string;
  model: string;
  name: string;
  price: number;
  currency: "USD";
  stock: number;
  inStock: boolean;
  deliveryDays: number;
  catalogue: "demo";
}

// ------------------------------------------------------------------ Scout: spec sheets

export function installSpecs(fleet: Fleet, agent: KohakuAgent): void {
  agent.sell<{ title: string; session?: string }, SpecSheet>({
    id: "specs",
    name: "Spec sheet",
    description: "Reads a product's Wikipedia infobox and returns its spec sheet (chip, display, cameras, battery, release date).",
    price: SHOP_PRICES.specs,
    unit: "product",
    tags: ["specs", "shopping", "research"],
    examples: ["{ \"title\": \"Pixel 10a\" }"],
    handler: async (input) => {
      fleet.touch("scout");
      return fetchSpecs(String(input.title).slice(0, 120));
    },
  });
}

// ------------------------------------------------------------------ demo stores

export function installStore(def: StoreDef) {
  return (fleet: Fleet, agent: KohakuAgent): void => {
    agent.sell<{ model: string; session?: string }, Quote>({
      id: "price-quote",
      name: "Price quote",
      description: `${def.name}'s price, stock and delivery time for one product (demo catalogue).`,
      price: SHOP_PRICES.quote,
      unit: "product",
      tags: ["store", "price", "shopping"],
      handler: async (input) => {
        fleet.touch(def.slug);
        const m = phone(String(input.model));
        const l = m ? def.listings[m.id] : undefined;
        if (!m || !l) throw new Error(`${def.name} does not sell ${input.model}`);
        return { store: def.slug, storeName: def.name, model: m.id, name: m.name, price: l.price, currency: "USD", stock: l.stock, inStock: l.stock > 0, deliveryDays: l.deliveryDays, catalogue: "demo" };
      },
    });
    agent.sell<{ session?: string }, { store: StoreSlug; storeName: string; codes: { code: string; description: string }[] }>({
      id: "promo-codes",
      name: "Promo codes",
      description: `The promo codes ${def.name} is advertising (demo catalogue). Not every code still redeems.`,
      price: SHOP_PRICES.promos,
      unit: "list",
      tags: ["store", "coupons", "shopping"],
      handler: async () => {
        fleet.touch(def.slug);
        return { store: def.slug, storeName: def.name, codes: def.coupons.map((c) => ({ code: c.code, description: c.description })) };
      },
    });
    agent.sell<{ code: string; model: string; price: number; session?: string }, { code: string; valid: boolean; discount: number; reason: string }>({
      id: "coupon-check",
      name: "Coupon check",
      description: `Checks whether a code redeems at ${def.name} for a product and price, and for how much.`,
      price: SHOP_PRICES.redeem,
      unit: "code",
      tags: ["store", "coupons", "shopping"],
      handler: async (input) => {
        fleet.touch(def.slug);
        const m = phone(String(input.model));
        if (!m) throw new Error(`unknown product ${input.model}`);
        return { code: String(input.code), ...redeem(def, String(input.code), m, Number(input.price)) };
      },
    });
  };
}

// ------------------------------------------------------------------ Pricewise

export function installPricewise(fleet: Fleet, agent: KohakuAgent): void {
  agent.sell<{ models: string[]; session?: string }, { offers: Record<string, ShopOffer[]>; quotes: number }>({
    id: "compare",
    name: "Price comparison",
    description: "Compares price, stock and delivery for a list of products across every store on Kohaku, buying one quote per store per product.",
    price: SHOP_PRICES.compare,
    unit: "comparison",
    tags: ["price", "compare", "shopping"],
    handler: async (input, ctx) => {
      const models = (input.models ?? []).map(String).filter((m) => phone(m)).slice(0, 10);
      const session = input.session;
      const pairs = models.flatMap((m) => STORES.map((s) => ({ m, s })));
      const quotes = await pool(pairs, 6, async ({ m, s }, i) => {
        if (i < 6) await sleep(i * 60);
        const r = await fleet
          .hireFrom<Quote>("pricewise", s.slug, "price-quote", { model: m, session }, { parentJobId: ctx.jobId, session })
          .catch(() => null);
        return r?.result ?? null;
      });
      const offers: Record<string, ShopOffer[]> = {};
      for (const q of quotes) {
        if (!q) continue;
        (offers[q.model] ??= []).push({ store: q.store, storeName: q.storeName, price: q.price, stock: q.stock, deliveryDays: q.deliveryDays, coupon: null, final: q.price });
      }
      for (const list of Object.values(offers)) list.sort((a, b) => a.price - b.price);
      if (session) fleet.shop.step(session, "Pricewise", `bought ${quotes.filter(Boolean).length} quotes from ${STORES.length} stores`);
      fleet.touch("pricewise");
      return { offers, quotes: quotes.filter(Boolean).length };
    },
  });
}

// ------------------------------------------------------------------ Clipper

export function installClipper(fleet: Fleet, agent: KohakuAgent): void {
  agent.sell<{ offers: { model: string; store: StoreSlug; price: number }[]; session?: string }, { best: { model: string; store: StoreSlug; code: string; discount: number; description: string }[]; checked: number }>({
    id: "best-coupon",
    name: "Coupon hunt",
    description: "Finds the best coupon for each offer: buys each store's promo list, then checks every code against the exact product and price.",
    price: SHOP_PRICES.coupons,
    unit: "hunt",
    tags: ["coupons", "deals", "shopping"],
    handler: async (input, ctx) => {
      const session = input.session;
      const offers = (input.offers ?? []).filter((o) => store(o.store) && phone(o.model)).slice(0, 12);
      const stores = [...new Set(offers.map((o) => o.store))];
      const lists = new Map<string, string[]>();
      await Promise.all(
        stores.map(async (slug) => {
          const r = await fleet
            .hireFrom<{ codes: { code: string }[] }>("clipper", slug, "promo-codes", { session }, { parentJobId: ctx.jobId, session })
            .catch(() => null);
          lists.set(slug, (r?.result.codes ?? []).map((c) => c.code));
        }),
      );
      const checks = offers.flatMap((o) => (lists.get(o.store) ?? []).map((code) => ({ o, code })));
      const results = await pool(checks, 6, async ({ o, code }, i) => {
        if (i < 6) await sleep(i * 50);
        const r = await fleet
          .hireFrom<{ valid: boolean; discount: number; reason: string }>("clipper", o.store, "coupon-check", { code, model: o.model, price: o.price, session }, { parentJobId: ctx.jobId, session })
          .catch(() => null);
        return r ? { o, code, ...r.result } : null;
      });
      const best: { model: string; store: StoreSlug; code: string; discount: number; description: string }[] = [];
      for (const o of offers) {
        const top = results
          .filter((r): r is NonNullable<typeof r> => !!r && r.valid && r.o === o)
          .sort((a, b) => b.discount - a.discount)[0];
        if (top) best.push({ model: o.model, store: o.store, code: top.code, discount: top.discount, description: top.reason });
      }
      const valid = results.filter((r) => r?.valid).length;
      if (session) fleet.shop.step(session, "Clipper", `checked ${results.filter(Boolean).length} codes across ${stores.length} stores; ${valid} redeem`);
      fleet.touch("clipper");
      return { best, checked: results.filter(Boolean).length };
    },
  });
}

// ------------------------------------------------------------------ Concierge

export interface ShopResult {
  session: string;
  screen: string;
  need: string;
  budgetUsd: number | null;
  options: ShopOption[];
  summary: string | null;
  jobs: number;
  spentUsd: string;
  catalogue: string;
}

export function installConcierge(fleet: Fleet, agent: KohakuAgent): void {
  agent.sell<{ need: string; budgetUsd?: number }, ShopResult>({
    id: "shop",
    name: "Shopping research",
    description:
      "Researches a purchase end to end: hires Pricewise to compare stores, Scout for live spec sheets, Clipper for the best coupons and Scribe for a summary, then returns ranked options ready to add to a cart.",
    price: SHOP_PRICES.shop,
    unit: "request",
    tags: ["shopping", "research", "deals"],
    examples: ["{ \"need\": \"a phone under $500 with a great camera\", \"budgetUsd\": 500 }"],
    handler: async (input, ctx) => {
      const need = String(input.need ?? "").slice(0, 300) || "a new phone";
      const budget = Number(input.budgetUsd) > 0 ? Number(input.budgetUsd) : budgetIn(need);
      const buyer = await fleet.agentSummary(ctx.buyer).catch(() => null);
      const s = fleet.shop.create(need, budget, { agentId: ctx.buyer, name: buyer?.name ?? `Agent #${ctx.buyer}` }, ctx.jobId);
      const intentId = fleet.standing.get("concierge:main");
      fleet.shop.job(s.id, { jobId: ctx.jobId, at: Date.now(), buyer: ctx.buyer, seller: agent.agentId.toString(), service: "shop", price: SHOP_PRICES.shop.toString(), epoch: 0, parentJobId: null });
      const step = (t: string) => {
        fleet.shop.step(s.id, "Concierge", t);
        fleet.log("concierge", `[${s.id}] ${t}`);
      };
      try {
        step(`new request: "${need}"${budget ? ` (budget $${budget})` : ""}`);
        // 1. candidates: every phone in the catalogue, or the brands the request names
        const brands = brandsIn(need);
        const candidates = PHONES.filter((p) => !brands.length || brands.includes(p.brand));
        step(`shortlisted ${candidates.length} phones${brands.length ? ` from ${brands.join(", ")}` : ""}; hiring Pricewise`);

        // 2. prices across stores
        const cmp = await fleet.hireFrom<{ offers: Record<string, ShopOffer[]> }>("concierge", "pricewise", "compare", { models: candidates.map((c) => c.id), session: s.id }, { intentId, parentJobId: ctx.jobId, session: s.id });
        if (s.jobs[0] && s.jobs[0].epoch === 0) s.jobs[0].epoch = cmp.epoch; // the buyer's job clears in the same epoch
        const inStock = (m: PhoneModel) => (cmp.result.offers[m.id] ?? []).filter((o) => o.stock > 0);
        const priced = candidates.filter((m) => inStock(m).length > 0);
        const within = priced.filter((m) => !budget || inStock(m)[0]!.price <= budget * 1.08);
        const pool3 = (within.length ? within : priced).sort((a, b) => inStock(b)[0]!.price - inStock(a)[0]!.price).slice(0, 4);
        step(`${priced.length} phones in stock, ${within.length} near the budget; reading spec sheets for ${pool3.map((m) => m.name).join(", ")}`);

        // 3. live spec sheets from Wikipedia, through Scout
        const specs = new Map<string, SpecSheet | null>();
        await Promise.all(
          pool3.map(async (m) => {
            const r = await fleet.hireFrom<SpecSheet>("concierge", "scout", "specs", { title: m.wiki, session: s.id }, { intentId, parentJobId: ctx.jobId, session: s.id }).catch(() => null);
            specs.set(m.id, r?.result ?? null);
          }),
        );

        // 4. coupons for every in-stock offer of the finalists: a coupon can change which store wins
        const offers = pool3.flatMap((m) => inStock(m).map((o) => ({ model: m.id, store: o.store, price: o.price })));
        step(`hiring Clipper to try coupons on ${offers.length} offers`);
        const cp = await fleet
          .hireFrom<{ best: { model: string; store: StoreSlug; code: string; discount: number; description: string }[] }>("concierge", "clipper", "best-coupon", { offers, session: s.id }, { intentId, parentJobId: ctx.jobId, session: s.id })
          .catch(() => null);
        const coupon = (model: string, st: StoreSlug) => cp?.result.best.find((b) => b.model === model && b.store === st) ?? null;

        // 5. rank: phones that fit the budget first, then the best deal after coupons (the
        //    shortlist is already the best-equipped phones near the budget)
        const options: ShopOption[] = pool3.map((m) => {
          const list = inStock(m)
            .map((o) => {
              const c = coupon(m.id, o.store);
              return { ...o, coupon: c ? { code: c.code, discount: c.discount, description: c.description } : null, final: round2(o.price - (c?.discount ?? 0)) };
            })
            .sort((a, b) => a.final - b.final || a.deliveryDays - b.deliveryDays);
          return { rank: 0, modelId: m.id, name: m.name, brand: m.brand, specs: specs.get(m.id) ?? null, best: list[0]!, offers: list, withinBudget: !budget || list[0]!.final <= budget };
        });
        options.sort((a, b) => Number(b.withinBudget) - Number(a.withinBudget) || a.best.final - b.best.final || a.best.deliveryDays - b.best.deliveryDays);
        options.forEach((o, i) => (o.rank = i + 1));
        s.options = options;
        fleet.shop.touch(s);

        // 6. a short write-up of the decision, bought from Scribe
        const wantsCamera = /camera|photo|picture|video|selfie/i.test(need);
        const text = options
          .map((o) => {
            const cam = o.specs?.rearCamera?.split(";")[0]?.trim();
            const deal = o.best.coupon ? `after code ${o.best.coupon.code} saves $${o.best.coupon.discount}` : "with no coupon that applies";
            return `Option ${o.rank}, the ${o.name}, is $${o.best.final.toFixed(2)} at ${o.best.storeName} ${deal}, delivered in ${o.best.deliveryDays} day${o.best.deliveryDays === 1 ? "" : "s"}${o.withinBudget ? "" : ", which is over the budget"}.${cam && wantsCamera ? ` Its main camera is ${cam}.` : o.specs?.chip ? ` It runs on the ${o.specs.chip}.` : ""}`;
          })
          .join(" ");
        const sum = await fleet.hireFrom<{ summary: string }>("concierge", "scribe", "summarize", { title: need, text, maxSentences: 3 }, { intentId, parentJobId: ctx.jobId, session: s.id }).catch(() => null);
        s.summary = sum?.result.summary ?? null;
        s.status = "ready";
        const spent = s.jobs.reduce((a, j) => a + BigInt(j.price), 0n);
        step(`done: ${options.length} options, ${s.jobs.length} paid jobs between agents`);
        fleet.shop.touch(s);
        return {
          session: s.id,
          screen: `${fleet.cfg.webUrl}/shop/${s.id}`,
          need,
          budgetUsd: budget,
          options,
          summary: s.summary,
          jobs: s.jobs.length,
          spentUsd: (Number(spent) / 1e6).toFixed(4),
          catalogue: "Store prices, stock and coupons come from Kohaku's demo catalogue (sample data); specs are live from Wikipedia.",
        };
      } catch (err) {
        s.status = "failed";
        s.error = (err as Error).message;
        step(`failed: ${s.error}`);
        throw err;
      }
    },
  });
}

function budgetIn(text: string): number | null {
  const m = text.match(/(?:under|below|less than|max(?:imum)?|budget(?: of)?|upto|up to|within)?\s*\$\s?(\d{2,5})|(\d{2,5})\s*(?:usd|dollars)/i);
  const v = Number(m?.[1] ?? m?.[2]);
  return v > 0 ? v : null;
}

async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
