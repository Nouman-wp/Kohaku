/** Small, dependency-free text utilities the agents use for their actual work. */

export const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by can " +
    "could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in " +
    "into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she " +
    "should so some such than that the their theirs them themselves then there these they this those through to too under until up very was " +
    "we were what when where which while who whom why will with you your yours yourself yourselves one two first new used known many may " +
    "would it's s t its per via within without across among"
  ).split(/\s+/),
);

export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function sentences(s: string): string[] {
  return s
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?।])\s+(?=[A-Z0-9"'ऀ-ॿ])/u)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** Share of `a`'s content words that also appear in `b` (0..1). */
export function overlap(a: string, b: string): number {
  const ta = new Set(tokens(a));
  if (ta.size === 0) return 0;
  const tb = new Set(tokens(b));
  let hit = 0;
  for (const w of ta) if (tb.has(w) || tb.has(w.replace(/s$/, ""))) hit++;
  return hit / ta.size;
}

export function numbersIn(s: string): string[] {
  return (s.match(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\b/g) ?? []).map((n) => n.replace(/,/g, ""));
}

/** Frequency-based extractive summary: the most informative sentences, in original order. */
export function summarize(text: string, maxSentences = 4): string {
  const sents = sentences(text).filter((s) => s.length > 30 && s.length < 400);
  if (sents.length <= maxSentences) return sents.join(" ");
  const freq = new Map<string, number>();
  for (const w of tokens(text)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scored = sents.map((s, i) => {
    const ws = tokens(s);
    const score = ws.reduce((a, w) => a + (freq.get(w) ?? 0), 0) / Math.sqrt(ws.length + 1);
    return { s, i, score: score * (i === 0 ? 1.15 : 1) };
  });
  const seen: string[] = [];
  const picked = scored
    .sort((a, b) => b.score - a.score)
    .filter((x) => {
      if (seen.some((p) => overlap(x.s, p) > 0.7)) return false;
      seen.push(x.s);
      return true;
    })
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i);
  return picked.map((x) => x.s).join(" ");
}

/** Pick checkable factual sentences: they carry a number or a named entity and are not too long. */
export function extractClaims(texts: string[], max = 5): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const s of sentences(t)) {
      if (s.length < 40 || s.length > 220) continue;
      const hasNumber = numbersIn(s).length > 0;
      const hasEntity = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/.test(s.slice(1));
      if (!hasNumber && !hasEntity) continue;
      if (out.some((o) => overlap(o, s) > 0.6)) continue;
      out.push(s);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function keywords(s: string, n = 6): string {
  return [...new Set(tokens(s))].slice(0, n).join(" ");
}

export function mainEntity(s: string): string | null {
  const m = s.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})\b/g);
  if (!m) return null;
  const candidates = m.filter((x, i) => !(i === 0 && s.startsWith(x) && x.split(" ").length === 1 && STOPWORDS.has(x.toLowerCase())));
  return candidates.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function devanagariRatio(s: string): number {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  const dev = s.match(/[ऀ-ॿ]/g) ?? [];
  return dev.length / letters.length;
}

export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
