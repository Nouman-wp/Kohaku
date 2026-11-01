import { describe, expect, it } from "vitest";
import { parseInfobox } from "../src/shop/specs.ts";
import { PHONES, STORES, brandsIn, phone, redeem, store } from "../src/shop/catalogue.ts";

const WIKITEXT = `'''Pixel 10a''' is a phone.
{{Infobox mobile phone
| name = Pixel 10a
| logo = <!-- file name only -->
| brand = [[Google]]
| released = {{Start date and age|2026|03|05}}
| os = '''Original:''' [[Android 16]] <br/> '''Current:''' [[Android 17]]
| soc = [[Google Tensor G4]]
| battery = 5100 [[ampere-hour|mAh]]
| display = {{ubl|{{convert|6.3|in|mm|0|abbr=on}} [[OLED|pOLED]] |{{resx|1080|2424}} px resolution}}
| rear_camera = {{ubl
 |48 [[Megapixel|MP]], {{f/}}1.7, 82° (wide), [[Optical Image Stabilization|OIS]]
 |13 [[Megapixel|MP]], {{f/}}2.2, 120˚ (ultrawide)
}}
| references = <ref>{{cite web |url= https://example.com |title= Specs}}</ref>
}}
The rest of the article.`;

describe("Wikipedia infobox parser", () => {
  const box = parseInfobox(WIKITEXT);
  it("flattens links, templates and lists", () => {
    expect(box.brand).toBe("Google");
    expect(box.released).toBe("2026-03-05");
    expect(box.os).toBe("Original: Android 16 ; Current: Android 17");
    expect(box.soc).toBe("Google Tensor G4");
    expect(box.battery).toBe("5100 mAh");
    expect(box.display).toBe("6.3 in pOLED; 1080×2424 px resolution");
    expect(box.rear_camera).toBe("48 MP, f/1.7, 82° (wide), OIS; 13 MP, f/2.2, 120˚ (ultrawide)");
  });
  it("drops comments and references", () => {
    expect(box.logo).toBeUndefined();
    expect(box.references).toBeUndefined();
  });
  it("returns nothing without an infobox", () => {
    expect(parseInfobox("no box here")).toEqual({});
  });
});

describe("demo catalogue", () => {
  const harbor = store("harbor-mobile")!;
  const amber = store("amber-mart")!;
  const pixel = phone("pixel-10a")!;
  const galaxy = phone("galaxy-a57")!;

  it("every store lists every phone", () => {
    for (const s of STORES) for (const p of PHONES) expect(s.listings[p.id], `${s.slug} ${p.id}`).toBeDefined();
  });
  it("redeems flat, brand-limited and percentage codes", () => {
    expect(redeem(harbor, "CAMERA30", pixel, 479)).toMatchObject({ valid: true, discount: 30 });
    expect(redeem(harbor, "camera30", galaxy, 489)).toMatchObject({ valid: false });
    expect(redeem(amber, "PIXELFAN", pixel, 499)).toMatchObject({ valid: true, discount: 40 });
    expect(redeem(store("lantern-tech")!, "LANTERN10", pixel, 289)).toMatchObject({ valid: false });
  });
  it("refuses expired and unknown codes", () => {
    expect(redeem(amber, "FESTIVE50", pixel, 499)).toMatchObject({ valid: false, discount: 0 });
    expect(redeem(amber, "NOPE", pixel, 499).reason).toMatch(/does not know/);
  });
  it("reads brands from a request", () => {
    expect(brandsIn("a Pixel or an iPhone")).toEqual(["Google", "Apple"]);
    expect(brandsIn("a phone under $500")).toEqual([]);
  });
});
