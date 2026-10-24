export interface Series {
  title: string;
  unit: string;
  points: { label: string; value: number }[];
}

export interface ChartDescription {
  description: string;
  stats: { count: number; min: number; max: number; mean: number; total: number; slope: number; trend: "rising" | "falling" | "flat" | "mixed" };
}

/**
 * Lens's work: turn a chart's data into an accessible description, the way a screen
 * reader alt text should read. Least-squares slope gives the trend; extremes and the
 * share of the leading point give the shape.
 */
export function describeChart(s: Series): ChartDescription {
  const pts = s.points.filter((p) => Number.isFinite(p.value));
  if (pts.length === 0) return { description: `The chart "${s.title}" has no data.`, stats: { count: 0, min: 0, max: 0, mean: 0, total: 0, slope: 0, trend: "flat" } };
  const values = pts.map((p) => p.value);
  const total = values.reduce((a, b) => a + b, 0);
  const mean = total / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const n = values.length;
  const xm = (n - 1) / 2;
  let num = 0;
  let den = 0;
  values.forEach((v, i) => {
    num += (i - xm) * (v - mean);
    den += (i - xm) ** 2;
  });
  const slope = den === 0 ? 0 : num / den;
  const rel = mean === 0 ? 0 : slope / Math.abs(mean);
  let ups = 0;
  let downs = 0;
  for (let i = 1; i < n; i++) {
    if (values[i]! > values[i - 1]!) ups++;
    if (values[i]! < values[i - 1]!) downs++;
  }
  const trend: ChartDescription["stats"]["trend"] = Math.abs(rel) < 0.03 ? "flat" : ups > 0 && downs > 0 && Math.abs(rel) < 0.15 ? "mixed" : rel > 0 ? "rising" : "falling";
  const top = pts.reduce((a, b) => (b.value > a.value ? b : a));
  const low = pts.reduce((a, b) => (b.value < a.value ? b : a));
  const fmt = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(v % 1 === 0 ? 0 : 2));
  const share = total > 0 ? Math.round((top.value / total) * 100) : 0;
  const parts = [
    `"${s.title}" compares ${n} ${n === 1 ? "value" : "values"} in ${s.unit}.`,
    trend === "flat" ? "The values stay roughly level." : trend === "mixed" ? "The values move up and down without a clear direction." : `Overall the values are ${trend}, by about ${fmt(Math.abs(slope))} ${s.unit} per step.`,
    `The highest is ${top.label} at ${fmt(top.value)}${share >= 30 && n > 2 ? ` (${share}% of the total)` : ""}; the lowest is ${low.label} at ${fmt(low.value)}.`,
    `The average is ${fmt(mean)} ${s.unit}.`,
  ];
  return { description: parts.join(" "), stats: { count: n, min, max, mean, total, slope, trend } };
}
