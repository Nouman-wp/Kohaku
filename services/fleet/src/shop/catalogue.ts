/**
 * The demo catalogue behind Kohaku's three demo stores. The phone models are real and
 * their specs are fetched live from Wikipedia; the stores, their prices, stock and coupon
 * codes are sample data for the testnet demo and are labelled that way everywhere they
 * are shown. Prices are in whole US dollars.
 */

export interface PhoneModel {
  id: string;
  name: string;
  brand: "Google" | "Apple" | "Samsung" | "OnePlus";
  /** exact English Wikipedia article title */
  wiki: string;
}

export const PHONES: PhoneModel[] = [
  { id: "pixel-10a", name: "Google Pixel 10a", brand: "Google", wiki: "Pixel 10a" },
  { id: "pixel-9a", name: "Google Pixel 9a", brand: "Google", wiki: "Pixel 9a" },
  { id: "iphone-17e", name: "Apple iPhone 17e", brand: "Apple", wiki: "IPhone 17e" },
  { id: "iphone-16e", name: "Apple iPhone 16e", brand: "Apple", wiki: "IPhone 16e" },
  { id: "galaxy-a57", name: "Samsung Galaxy A57 5G", brand: "Samsung", wiki: "Samsung Galaxy A57 5G" },
  { id: "galaxy-a56", name: "Samsung Galaxy A56 5G", brand: "Samsung", wiki: "Samsung Galaxy A56 5G" },
  { id: "oneplus-13r", name: "OnePlus 13R", brand: "OnePlus", wiki: "OnePlus 13R" },
  { id: "oneplus-13", name: "OnePlus 13", brand: "OnePlus", wiki: "OnePlus 13" },
];

export type StoreSlug = "amber-mart" | "lantern-tech" | "harbor-mobile";

export interface StoreListing {
  price: number;
  stock: number;
  deliveryDays: number;
}

export interface Coupon {
  code: string;
  description: string;
  kind: "flat" | "percent";
  amount: number;
  /** cap for percentage coupons */
  maxDiscount?: number;
  minSpend: number;
  brands?: PhoneModel["brand"][];
  /** false: the store still advertises it but it no longer redeems */
  active: boolean;
  inactiveReason?: string;
}

export interface StoreDef {
  slug: StoreSlug;
  name: string;
  tagline: string;
  listings: Partial<Record<string, StoreListing>>;
  coupons: Coupon[];
}

export const STORES: StoreDef[] = [
  {
    slug: "amber-mart",
    name: "Amber Mart",
    tagline: "Demo store: big catalogue, steady prices.",
    listings: {
      "pixel-10a": { price: 499, stock: 14, deliveryDays: 2 },
      "pixel-9a": { price: 449, stock: 9, deliveryDays: 2 },
      "iphone-17e": { price: 599, stock: 20, deliveryDays: 1 },
      "iphone-16e": { price: 549, stock: 6, deliveryDays: 2 },
      "galaxy-a57": { price: 479, stock: 11, deliveryDays: 3 },
      "galaxy-a56": { price: 429, stock: 4, deliveryDays: 3 },
      "oneplus-13r": { price: 549, stock: 7, deliveryDays: 2 },
      "oneplus-13": { price: 799, stock: 5, deliveryDays: 2 },
    },
    coupons: [
      { code: "AMBER25", description: "$25 off orders of $400 or more", kind: "flat", amount: 25, minSpend: 400, active: true },
      { code: "PIXELFAN", description: "10% off Google phones, up to $40", kind: "percent", amount: 10, maxDiscount: 40, minSpend: 0, brands: ["Google"], active: true },
      { code: "FESTIVE50", description: "$50 off any phone", kind: "flat", amount: 50, minSpend: 0, active: false, inactiveReason: "expired on 31 Oct 2026" },
    ],
  },
  {
    slug: "lantern-tech",
    name: "Lantern Tech",
    tagline: "Demo store: lowest list prices, slower delivery.",
    listings: {
      "pixel-10a": { price: 489, stock: 3, deliveryDays: 4 },
      "pixel-9a": { price: 429, stock: 12, deliveryDays: 4 },
      "iphone-17e": { price: 589, stock: 8, deliveryDays: 3 },
      "iphone-16e": { price: 529, stock: 10, deliveryDays: 4 },
      "galaxy-a57": { price: 469, stock: 0, deliveryDays: 5 },
      "galaxy-a56": { price: 399, stock: 15, deliveryDays: 4 },
      "oneplus-13r": { price: 539, stock: 4, deliveryDays: 4 },
      "oneplus-13": { price: 779, stock: 2, deliveryDays: 5 },
    },
    coupons: [
      { code: "LANTERN10", description: "10% off orders of $300 or more, up to $30", kind: "percent", amount: 10, maxDiscount: 30, minSpend: 300, active: true },
      { code: "NEWUSER15", description: "$15 off your first order", kind: "flat", amount: 15, minSpend: 0, active: true },
    ],
  },
  {
    slug: "harbor-mobile",
    name: "Harbor Mobile",
    tagline: "Demo store: camera-phone specialist, next-day delivery.",
    listings: {
      "pixel-10a": { price: 479, stock: 6, deliveryDays: 1 },
      "pixel-9a": { price: 439, stock: 0, deliveryDays: 1 },
      "iphone-17e": { price: 599, stock: 5, deliveryDays: 1 },
      "iphone-16e": { price: 539, stock: 8, deliveryDays: 1 },
      "galaxy-a57": { price: 489, stock: 9, deliveryDays: 1 },
      "galaxy-a56": { price: 419, stock: 7, deliveryDays: 1 },
      "oneplus-13r": { price: 529, stock: 10, deliveryDays: 2 },
      "oneplus-13": { price: 789, stock: 3, deliveryDays: 1 },
    },
    coupons: [
      { code: "HARBOR20", description: "$20 off orders of $450 or more", kind: "flat", amount: 20, minSpend: 450, active: true },
      { code: "CAMERA30", description: "$30 off Google and Apple camera phones over $450", kind: "flat", amount: 30, minSpend: 450, brands: ["Google", "Apple"], active: true },
      { code: "SUMMER40", description: "$40 off any phone", kind: "flat", amount: 40, minSpend: 0, active: false, inactiveReason: "summer sale ended" },
    ],
  },
];

export function phone(id: string): PhoneModel | undefined {
  return PHONES.find((p) => p.id === id);
}

export function store(slug: string): StoreDef | undefined {
  return STORES.find((s) => s.slug === slug);
}

/** Redeem check: the discount a code gives on one phone at one price, or why it does not apply. */
export function redeem(s: StoreDef, code: string, model: PhoneModel, price: number): { valid: boolean; discount: number; reason: string } {
  const c = s.coupons.find((x) => x.code.toUpperCase() === code.trim().toUpperCase());
  if (!c) return { valid: false, discount: 0, reason: `${s.name} does not know code ${code}` };
  if (!c.active) return { valid: false, discount: 0, reason: `${c.code} ${c.inactiveReason ?? "is no longer active"}` };
  if (price < c.minSpend) return { valid: false, discount: 0, reason: `${c.code} needs a spend of $${c.minSpend}` };
  if (c.brands && !c.brands.includes(model.brand)) return { valid: false, discount: 0, reason: `${c.code} is only for ${c.brands.join(" and ")} phones` };
  const raw = c.kind === "flat" ? c.amount : (price * c.amount) / 100;
  const discount = Math.round(Math.min(raw, c.maxDiscount ?? raw, price) * 100) / 100;
  return { valid: true, discount, reason: c.description };
}

/** Words in a request that point at a brand. */
export function brandsIn(text: string): PhoneModel["brand"][] {
  const t = text.toLowerCase();
  const out: PhoneModel["brand"][] = [];
  if (/\b(pixel|google)\b/.test(t)) out.push("Google");
  if (/\b(iphone|apple|ios)\b/.test(t)) out.push("Apple");
  if (/\b(samsung|galaxy)\b/.test(t)) out.push("Samsung");
  if (/\boneplus\b/.test(t)) out.push("OnePlus");
  return out;
}
