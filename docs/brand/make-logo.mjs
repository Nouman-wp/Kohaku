// Generates the Kohaku mark: a cut amber gem in the violet cosmos, with a constellation
// of agent nodes netted into one warm core. Writes SVG + PNG renders.
import { writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const out = process.argv[2] ?? ".";
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
    <radialGradient id="kb" cx="44%" cy="30%" r="78%">
      <stop offset="0" stop-color="#3a2391"/>
      <stop offset="0.42" stop-color="#1b0f57"/>
      <stop offset="1" stop-color="#070320"/>
    </radialGradient>
    <linearGradient id="kr" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#f3d2ff"/>
      <stop offset="0.45" stop-color="#ab92ff"/>
      <stop offset="1" stop-color="#6f7dff"/>
    </linearGradient>
    <radialGradient id="kc" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#fff6df"/>
      <stop offset="0.22" stop-color="#ffd27f"/>
      <stop offset="0.5" stop-color="#ff9f45" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="kh" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#c7b3ff" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#c7b3ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="kg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="kclip"><path d="${gemPath}"/></clipPath>
  </defs>
  <path d="${gemPath}" fill="url(#kb)"/>
  <g clip-path="url(#kclip)">
    <circle cx="${C}" cy="${C - 40}" r="230" fill="url(#kh)"/>
    <g stroke="#cbb8ff" stroke-opacity="0.22" stroke-width="3">${facetLines}</g>
    <path d="${tablePath}" fill="#ffffff" fill-opacity="0.035" stroke="#d9c9ff" stroke-opacity="0.28" stroke-width="3"/>
    <circle cx="${core[0]}" cy="${core[1]}" r="92" fill="url(#kc)"/>
    <g stroke="#efe6ff" stroke-opacity="0.75" stroke-width="4.5" stroke-linecap="round">
      ${nodes.map(([x, y]) => `<line x1="${x}" y1="${y}" x2="${core[0]}" y2="${core[1]}"/>`).join("")}
    </g>
    <g stroke="#efe6ff" stroke-opacity="0.32" stroke-width="3" stroke-linecap="round">
      <line x1="${nodes[0][0]}" y1="${nodes[0][1]}" x2="${nodes[1][0]}" y2="${nodes[1][1]}"/>
      <line x1="${nodes[2][0]}" y1="${nodes[2][1]}" x2="${nodes[3][0]}" y2="${nodes[3][1]}"/>
      <line x1="${nodes[3][0]}" y1="${nodes[3][1]}" x2="${nodes[4][0]}" y2="${nodes[4][1]}"/>
    </g>
    ${nodes.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#f4f0ff"/>`).join("")}
    <circle cx="${core[0]}" cy="${core[1]}" r="17" fill="#fff8e8"/>
    <path d="M ${C - 150} ${C - 120} Q ${C} ${C - 250} ${C + 150} ${C - 120} L ${C + 150} ${C - 260} L ${C - 150} ${C - 260} Z" fill="url(#kg)"/>
  </g>
  <path d="${gemPath}" fill="none" stroke="url(#kr)" stroke-width="9"/>
</svg>
`;

writeFileSync(`${out}/kohaku-mark.svg`, svg);
for (const size of [512, 180, 64, 32]) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(`${out}/kohaku-mark-${size}.png`, png);
}
// preview on the app's dark canvas
const preview = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 400" width="900" height="400">
  <rect width="900" height="400" fill="#030014"/>
  <g transform="translate(40,40) scale(0.625)">${svg.replace(/<\?xml[^>]*>/, "").replace(/<svg[^>]*>/, "").replace("</svg>", "")}</g>
  <g transform="translate(420,150) scale(0.125)">${svg.replace(/<svg[^>]*>/, "").replace("</svg>", "").replaceAll('id="k', 'id="s').replaceAll("url(#k", "url(#s")}</g>
  <text x="494" y="185" font-family="Segoe UI, Arial" font-weight="500" font-size="34" fill="#f4f0ff">Kohaku</text>
  <g transform="translate(420,260) scale(0.0625)">${svg.replace(/<svg[^>]*>/, "").replace("</svg>", "").replaceAll('id="k', 'id="t').replaceAll("url(#k", "url(#t")}</g>
</svg>`;
writeFileSync(`${out}/preview.png`, new Resvg(preview, { fitTo: { mode: "width", value: 900 }, font: { loadSystemFonts: true } }).render().asPng());
console.log("ok");
