// Generates the Kohaku mark: a cut gem on black with a lemon-green rim (caspx.in's palette),
// holding a constellation of agent nodes netted into one lit core. Flat colours only.
// Writes SVG + PNG renders.
import { writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const out = process.argv[2] ?? ".";
const LIME = "#b8f34d";
const INK = "#ececea";
const INK_BG = "#0a0a0a";
const C = 256;

function roundedPolygon(points, r) {
  // rounded corners via quadratic curves
  const n = points.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n];
    const v1 = [p0[0] - p1[0], p0[1] - p1[1]], v2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
    const a = [p1[0] + (v1[0] / l1) * r, p1[1] + (v1[1] / l1) * r];
    const b = [p1[0] + (v2[0] / l2) * r, p1[1] + (v2[1] / l2) * r];
    d += `${i === 0 ? "M" : "L"}${a[0].toFixed(2)},${a[1].toFixed(2)} Q${p1[0].toFixed(2)},${p1[1].toFixed(2)} ${b[0].toFixed(2)},${b[1].toFixed(2)} `;
  }
  return d + "Z";
}

// Gem outline: an elongated hexagon (a cut stone), pointy top and bottom
const R = 214;
const gem = [
  [C, C - R],
  [C + R * 0.82, C - R * 0.46],
  [C + R * 0.82, C + R * 0.46],
  [C, C + R],
  [C - R * 0.82, C + R * 0.46],
  [C - R * 0.82, C - R * 0.46],
];
const gemPath = roundedPolygon(gem, 46);

// Table facet (the flat top of the cut), slightly above centre
const T = 104;
const table = [
  [C, C - T * 1.02],
  [C + T * 0.88, C - T * 0.5],
  [C + T * 0.88, C + T * 0.5],
  [C, C + T * 1.02],
  [C - T * 0.88, C + T * 0.5],
  [C - T * 0.88, C - T * 0.5],
];
const tablePath = roundedPolygon(table, 18);

// Constellation: agents around the edge, all netted into one core
const core = [C, C + 4];
const nodes = [
  [C - 62, C - 70, 9],
  [C + 70, C - 52, 8],
  [C + 78, C + 50, 7],
  [C - 8, C + 84, 8],
  [C - 82, C + 36, 7],
];
const facetLines = gem.map((p, i) => `<line x1="${p[0]}" y1="${p[1]}" x2="${table[i][0]}" y2="${table[i][1]}" />`).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <clipPath id="kclip"><path d="${gemPath}"/></clipPath>
  </defs>
  <path d="${gemPath}" fill="${INK_BG}"/>
  <g clip-path="url(#kclip)">
    <g stroke="${INK}" stroke-opacity="0.16" stroke-width="3">${facetLines}</g>
    <path d="${tablePath}" fill="none" stroke="${INK}" stroke-opacity="0.24" stroke-width="3"/>
    <g stroke="${INK}" stroke-opacity="0.8" stroke-width="4.5" stroke-linecap="round">
      ${nodes.map(([x, y]) => `<line x1="${x}" y1="${y}" x2="${core[0]}" y2="${core[1]}"/>`).join("")}
    </g>
    <g stroke="${INK}" stroke-opacity="0.3" stroke-width="3" stroke-linecap="round">
      <line x1="${nodes[0][0]}" y1="${nodes[0][1]}" x2="${nodes[1][0]}" y2="${nodes[1][1]}"/>
      <line x1="${nodes[2][0]}" y1="${nodes[2][1]}" x2="${nodes[3][0]}" y2="${nodes[3][1]}"/>
      <line x1="${nodes[3][0]}" y1="${nodes[3][1]}" x2="${nodes[4][0]}" y2="${nodes[4][1]}"/>
    </g>
    ${nodes.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${INK}"/>`).join("")}
    <circle cx="${core[0]}" cy="${core[1]}" r="38" fill="${LIME}" fill-opacity="0.16"/>
    <circle cx="${core[0]}" cy="${core[1]}" r="22" fill="${LIME}"/>
  </g>
  <path d="${gemPath}" fill="none" stroke="${LIME}" stroke-width="10"/>
</svg>
`;

writeFileSync(`${out}/kohaku-mark.svg`, svg);
for (const size of [512, 180, 64, 32]) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(`${out}/kohaku-mark-${size}.png`, png);
}
// preview on the app's dark canvas
const preview = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 400" width="900" height="400">
  <rect width="900" height="400" fill="#000"/>
  <g transform="translate(40,40) scale(0.625)">${svg.replace(/<\?xml[^>]*>/, "").replace(/<svg[^>]*>/, "").replace("</svg>", "")}</g>
  <g transform="translate(420,150) scale(0.125)">${svg.replace(/<svg[^>]*>/, "").replace("</svg>", "").replaceAll('id="k', 'id="s').replaceAll("url(#k", "url(#s")}</g>
  <text x="494" y="185" font-family="Segoe UI, Arial" font-weight="500" font-size="34" fill="#ececea">Kohaku</text>
  <g transform="translate(420,260) scale(0.0625)">${svg.replace(/<svg[^>]*>/, "").replace("</svg>", "").replaceAll('id="k', 'id="t').replaceAll("url(#k", "url(#t")}</g>
</svg>`;
writeFileSync(`${out}/preview.png`, new Resvg(preview, { fitTo: { mode: "width", value: 900 }, font: { loadSystemFonts: true } }).render().asPng());
console.log("ok");
