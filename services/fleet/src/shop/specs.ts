/**
 * Live phone specs from English Wikipedia: one API request per article returns the intro
 * extract and the lead section's wikitext, whose "Infobox mobile phone" is parsed into a
 * flat spec sheet. Results are cached for six hours.
 */

export interface SpecSheet {
  title: string;
  url: string;
  intro: string;
  released: string | null;
  os: string | null;
  chip: string | null;
  display: string | null;
  rearCamera: string | null;
  frontCamera: string | null;
  battery: string | null;
  charging: string | null;
  memory: string | null;
  storage: string | null;
  water: string | null;
  weight: string | null;
  /** largest rear sensor in megapixels, and how many rear cameras the infobox lists */
  camera: { maxMp: number; lenses: number };
  source: "wikipedia";
}

const UA = "Kohaku/0.1 (HashKey Chain hackathon agent fleet; https://github.com/Nouman-wp/Kohaku)";
const cache = new Map<string, { at: number; value: Promise<SpecSheet> }>();
const TTL = 6 * 3_600_000;

export function fetchSpecs(title: string): Promise<SpecSheet> {
  const key = title.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = load(title);
  value.catch(() => cache.delete(key));
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function load(title: string): Promise<SpecSheet> {
  const u = new URL("https://en.wikipedia.org/w/api.php");
  u.search = new URLSearchParams({
    action: "query",
    prop: "extracts|revisions",
    exintro: "1",
    explaintext: "1",
    exsentences: "3",
    rvprop: "content",
    rvslots: "main",
    rvsection: "0",
    titles: title,
    redirects: "1",
    format: "json",
    formatversion: "2",
    origin: "*",
  }).toString();
  const res = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`wikipedia HTTP ${res.status}`);
  const data = (await res.json()) as {
    query?: { pages?: { title: string; missing?: boolean; extract?: string; revisions?: { slots?: { main?: { content?: string } } }[] }[] };
  };
  const page = data.query?.pages?.[0];
  if (!page || page.missing) throw new Error(`no Wikipedia article "${title}"`);
  const wikitext = page.revisions?.[0]?.slots?.main?.content ?? "";
  const box = parseInfobox(wikitext);
  const f = (...keys: string[]) => {
    for (const k of keys) {
      const v = box[k];
      if (v) return v.length > 180 ? `${v.slice(0, 177)}…` : v;
    }
    return null;
  };
  const rear = box.rear_camera ?? "";
  const mps = [...rear.matchAll(/(\d+(?:\.\d+)?)\s*MP/gi)].map((m) => Number(m[1]));
  return {
    title: page.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    intro: (page.extract ?? "").trim(),
    released: f("released", "first_released", "available"),
    os: f("os"),
    chip: f("soc", "cpu"),
    display: f("display"),
    rearCamera: f("rear_camera", "camera"),
    frontCamera: f("front_camera"),
    battery: f("battery"),
    charging: f("charging"),
    memory: f("memory"),
    storage: f("storage"),
    water: f("water_resistance"),
    weight: f("weight"),
    camera: { maxMp: mps.length ? Math.max(...mps) : 0, lenses: mps.length },
    source: "wikipedia",
  };
}

/** The fields of the first infobox in a page's wikitext, flattened to plain text. */
export function parseInfobox(wikitext: string): Record<string, string> {
  const start = wikitext.search(/\{\{\s*Infobox/i);
  if (start < 0) return {};
  let depth = 0;
  let end = -1;
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext[i] === "{" && wikitext[i + 1] === "{") {
      depth++;
      i++;
    } else if (wikitext[i] === "}" && wikitext[i + 1] === "}") {
      depth--;
      i++;
      if (depth === 0) {
        end = i - 1;
        break;
      }
    }
  }
  if (end < 0) return {};
  let body = wikitext.slice(start + 2, end);
  body = body.replace(/^\s*Infobox[^\n|]*/i, "");
  body = expand(prepare(body));
  const out: Record<string, string> = {};
  const parts = body.split(/\n\s*\|\s*(?=[a-z_0-9]+\s*=)/i);
  for (const part of parts) {
    const m = part.match(/^\s*\|?\s*([a-z_0-9]+)\s*=\s*([\s\S]*)$/i);
    if (!m) continue;
    const value = finish(m[2]!);
    if (value) out[m[1]!.toLowerCase()] = value;
  }
  return out;
}

/** Comments, references and links, which never contain template braces. */
function prepare(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, "$1");
}

/** Expand the templates that carry spec values, innermost first; drop the rest. */
function expand(s: string): string {
  for (let guard = 0; guard < 60 && s.includes("{{"); guard++) {
    s = s.replace(/\{\{([^{}]*)\}\}/g, (_m, inner: string) => template(inner));
  }
  return s;
}

function template(inner: string): string {
  const [rawName, ...rest] = inner.split("|");
  const name = (rawName ?? "").trim().toLowerCase();
  const params = rest.map((p) => p.trim());
  const positional = params.filter((p) => !/^[a-z_ ]+=/i.test(p));
  const list = (items: string[]) =>
    items
      .flatMap((p) => p.split(/\n\s*\*\s*|^\s*\*\s*/))
      .map((x) => x.trim())
      .filter(Boolean)
      .join("; ");
  switch (name) {
    case "convert":
    case "cvt":
      return positional.length >= 2 ? `${positional[0]} ${positional[1]}` : (positional[0] ?? "");
    case "start date and age":
    case "start date":
    case "release date":
    case "release date and age":
    case "date":
      return positional.slice(0, 3).filter((p) => /^\d+$/.test(p)).join("-");
    case "resx":
      return positional.slice(0, 2).join("×");
    case "f/":
      return "f/";
    case "nbsp":
      return " ";
    case "ubl":
    case "unbulleted list":
    case "plainlist":
    case "plain list":
    case "flatlist":
    case "hlist":
    case "bulleted list":
    case "ublist":
      return list(positional);
    case "abbr":
    case "abbrlink":
      return positional[0] ?? "";
    case "url":
      return positional[1] ?? positional[0] ?? "";
    default:
      return "";
  }
}

function finish(s: string): string {
  return s
    .replace(/'''?/g, "")
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\n\s*\*\s*/g, "; ")
    .replace(/\s+/g, " ")
    .replace(/(;\s*)+/g, "; ")
    .replace(/^[;\s]+|[;\s]+$/g, "")
    .trim();
}
