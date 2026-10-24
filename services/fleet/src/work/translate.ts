import { hash32, sentences } from "./text.ts";

export interface Translation {
  translation: string;
  engine: "mymemory" | "offline-glossary" | "identity";
}

const cache = new Map<number, Promise<Translation>>();
let offlineUntil = 0;

/**
 * Polyglot's work. Primary engine: the MyMemory translation API (free, no key; set
 * MYMEMORY_EMAIL for a higher daily quota). Results are cached by content. When the API
 * is unreachable or out of quota, an offline glossary engine translates common words and
 * transliterates the rest into Devanagari; its output is labelled `offline-glossary`.
 */
export function translate(text: string, from: string, to: string): Promise<Translation> {
  if (from === to || !text.trim()) return Promise.resolve({ translation: text, engine: "identity" });
  const key = hash32(`${from}>${to}:${text}`);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (Date.now() < offlineUntil || process.env.KOHAKU_OFFLINE === "1" ? Promise.reject(new Error("offline")) : viaMyMemory(text, from, to)).catch(() => {
    offlineUntil = Date.now() + 120_000;
    return { translation: to === "hi" ? glossaryHindi(text) : text, engine: "offline-glossary" as const };
  });
  cache.set(key, p);
  if (cache.size > 3000) cache.delete(cache.keys().next().value!);
  return p;
}

async function viaMyMemory(text: string, from: string, to: string): Promise<Translation> {
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences(text)) {
    if ((cur + " " + s).length > 450 && cur) {
      chunks.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) chunks.push(cur);
  const out: string[] = [];
  for (const c of chunks) {
    const u = new URL("https://api.mymemory.translated.net/get");
    u.searchParams.set("q", c.slice(0, 480));
    u.searchParams.set("langpair", `${from}|${to}`);
    if (process.env.MYMEMORY_EMAIL) u.searchParams.set("de", process.env.MYMEMORY_EMAIL);
    const res = await fetch(u, { signal: AbortSignal.timeout(8_000) });
    const d = (await res.json()) as { responseStatus: number | string; quotaFinished?: boolean; responseData?: { translatedText?: string } };
    if (Number(d.responseStatus) !== 200 || d.quotaFinished || !d.responseData?.translatedText) throw new Error(`mymemory: ${d.responseStatus}`);
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(d.responseData.translatedText)) throw new Error("mymemory quota");
    out.push(d.responseData.translatedText);
  }
  return { translation: out.join(" "), engine: "mymemory" };
}

// ------------------------------------------------------------------ offline glossary

const HI: Record<string, string> = {
  the: "", a: "एक", an: "एक", is: "है", are: "हैं", was: "था", were: "थे", and: "और", or: "या", of: "का", in: "में", on: "पर", to: "को",
  for: "के लिए", with: "के साथ", by: "द्वारा", from: "से", it: "यह", this: "यह", that: "वह", its: "इसका", as: "के रूप में", at: "पर",
  india: "भारत", indian: "भारतीय", world: "विश्व", country: "देश", city: "शहर", capital: "राजधानी", state: "राज्य", government: "सरकार",
  people: "लोग", year: "वर्ष",years: "वर्ष", million: "मिलियन", billion: "अरब", largest: "सबसे बड़ा", first: "पहला", new: "नया",
  bank: "बैंक", money: "पैसा", payment: "भुगतान", payments: "भुगतान", system: "प्रणाली", network: "नेटवर्क", chain: "चेन",
  financial: "वित्तीय", centre: "केंद्र", center: "केंद्र", market: "बाज़ार", token: "टोकन", agent: "एजेंट", agents: "एजेंट",
  settlement: "निपटान", clearing: "समाशोधन", house: "गृह", research: "अनुसंधान", report: "रिपोर्ट", brief: "सारांश",
  language: "भाषा", official: "आधिकारिक", water: "पानी", rain: "बारिश", energy: "ऊर्जा", solar: "सौर", power: "शक्ति",
  space: "अंतरिक्ष", moon: "चंद्रमा", mission: "मिशन", film: "फ़िल्म", industry: "उद्योग", game: "खेल", team: "टीम",
  river: "नदी", built: "बनाया गया", called: "कहा जाता है", known: "जाना जाता है", used: "उपयोग किया जाता है", also: "भी", most: "सबसे",
  more: "अधिक", than: "से", has: "है", have: "हैं", been: "रहा है", which: "जो", who: "जो", one: "एक", two: "दो", three: "तीन",
};

const V: Record<string, string> = { a: "अ", aa: "आ", i: "इ", ee: "ई", u: "उ", oo: "ऊ", e: "ए", ai: "ऐ", o: "ओ", au: "औ" };
const M: Record<string, string> = { a: "", aa: "ा", i: "ि", ee: "ी", u: "ु", oo: "ू", e: "े", ai: "ै", o: "ो", au: "ौ" };
const C: [string, string][] = [
  ["chh", "छ"], ["kh", "ख"], ["gh", "घ"], ["ch", "च"], ["jh", "झ"], ["th", "थ"], ["dh", "ध"], ["ph", "फ"], ["bh", "भ"], ["sh", "श"],
  ["k", "क"], ["g", "ग"], ["c", "क"], ["j", "ज"], ["t", "ट"], ["d", "ड"], ["n", "न"], ["p", "प"], ["b", "ब"], ["m", "म"], ["y", "य"],
  ["r", "र"], ["l", "ल"], ["v", "व"], ["w", "व"], ["s", "स"], ["h", "ह"], ["f", "फ़"], ["z", "ज़"], ["q", "क"], ["x", "क्स"],
];

function transliterate(word: string): string {
  const w = word.toLowerCase();
  let out = "";
  let i = 0;
  let prevConsonant = false;
  while (i < w.length) {
    const vowel = ["aa", "ee", "oo", "ai", "au", "a", "i", "u", "e", "o"].find((v) => w.startsWith(v, i));
    if (vowel) {
      out += prevConsonant ? M[vowel] : V[vowel];
      prevConsonant = false;
      i += vowel.length;
      continue;
    }
    const cons = C.find(([l]) => w.startsWith(l, i));
    if (cons) {
      if (prevConsonant) out += "्";
      out += cons[1];
      prevConsonant = true;
      i += cons[0].length;
      continue;
    }
    out += w[i];
    prevConsonant = false;
    i++;
  }
  return out;
}

export function glossaryHindi(text: string): string {
  return text
    .split(/(\s+|[.,;:!?()"])/)
    .map((tok) => {
      if (!/[A-Za-z]/.test(tok)) return tok === "." ? "।" : tok;
      const k = tok.toLowerCase();
      return k in HI ? HI[k]! : transliterate(tok);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
