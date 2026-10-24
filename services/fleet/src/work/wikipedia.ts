import { CORPUS } from "./corpus.ts";
import { overlap, stripHtml, tokens } from "./text.ts";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  extract?: string;
}

export interface SearchResult {
  query: string;
  lang: string;
  source: "wikipedia" | "offline";
  hits: SearchHit[];
}

const UA = "Kohaku/0.1 (HashKey Chain hackathon agent fleet; https://github.com/Nouman-wp/Kohaku)";
const cache = new Map<string, { at: number; result: Promise<SearchResult> }>();
const TTL = 30 * 60_000;
let offlineUntil = 0;

/**
 * Real search: the Wikipedia API (search + intro extracts). Results are cached for 30
 * minutes and concurrent identical queries share one request. If Wikipedia cannot be
 * reached, falls back to the bundled offline corpus for a minute before retrying.
 */
export function wikiSearch(query: string, lang = "en", limit = 4): Promise<SearchResult> {
  const key = `${lang}:${query.toLowerCase().trim()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.result;
  const result = (Date.now() < offlineUntil || process.env.KOHAKU_OFFLINE === "1" ? Promise.resolve(offline(query, lang, limit)) : online(query, lang, limit)).catch(() => {
    offlineUntil = Date.now() + 60_000;
    return offline(query, lang, limit);
  });
  cache.set(key, { at: Date.now(), result });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return result;
}

async function online(query: string, lang: string, limit: number): Promise<SearchResult> {
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  const s = new URL(base);
  s.search = new URLSearchParams({ action: "query", list: "search", srsearch: query, srlimit: String(limit), format: "json", utf8: "1", origin: "*" }).toString();
  const res = await fetch(s, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(6_000) });
  if (!res.ok) throw new Error(`wikipedia HTTP ${res.status}`);
  const data = (await res.json()) as { query?: { search?: { title: string; snippet: string }[] } };
  const raw = data.query?.search ?? [];
  const hits: SearchHit[] = raw.map((r) => ({
    title: r.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
    snippet: stripHtml(r.snippet),
  }));
  const top = hits.slice(0, 2).map((h) => h.title);
  if (top.length) {
    const e = new URL(base);
    e.search = new URLSearchParams({ action: "query", prop: "extracts", exintro: "1", explaintext: "1", exsentences: "5", titles: top.join("|"), format: "json", utf8: "1", origin: "*" }).toString();
    try {
      const er = await fetch(e, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(6_000) });
      const ed = (await er.json()) as { query?: { pages?: Record<string, { title: string; extract?: string }> } };
      for (const p of Object.values(ed.query?.pages ?? {})) {
        const h = hits.find((x) => x.title === p.title);
        if (h && p.extract) h.extract = p.extract.slice(0, 1500);
      }
    } catch {
      // extracts are a bonus
    }
  }
  return { query, lang, source: "wikipedia", hits };
}

function offline(query: string, lang: string, limit: number): SearchResult {
  const q = tokens(query);
  const scored = CORPUS.map((d) => {
    const body = `${d.title} ${d.text}`;
    const t = new Set(tokens(body));
    const score = q.reduce((a, w) => a + (t.has(w) ? 1 : 0), 0) + overlap(query, d.title) * 2;
    return { d, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return {
    query,
    lang,
    source: "offline",
    hits: scored.map(({ d }) => ({ title: d.title, url: d.url, snippet: d.text.slice(0, 160), extract: d.text })),
  };
}
