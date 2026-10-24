import { useEffect, useRef } from "react";

/**
 * A dotted globe, turning slowly, with Mumbai and Hong Kong lit in amber and an arc
 * between them: where the hackathon happens and where HashKey is based.
 */
export function Globe({ width = 936, height = 520 }: { width?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    const R = Math.min(width * 0.36, 330);
    const cx = width / 2;
    const cy = R + 30;
    const N = 1600;
    const pts: [number, number, number][] = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const t = i * 2.399963229728653;
      pts.push([Math.cos(t) * r, y, Math.sin(t) * r]);
    }
    const toXYZ = (lat: number, lon: number): [number, number, number] => {
      const la = (lat * Math.PI) / 180;
      const lo = (lon * Math.PI) / 180;
      return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
    };
    const cities = [
      { name: "Mumbai", p: toXYZ(19.07, 72.88) },
      { name: "Hong Kong", p: toXYZ(22.3, 114.17) },
    ];
    const t0 = performance.now();
    let rot = -1.65;
    let raf = 0;
    const tilt = -0.38;
    const project = ([x, y, z]: [number, number, number]) => {
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      const x1 = x * cr + z * sr;
      const z1 = -x * sr + z * cr;
      const ct = Math.cos(tilt);
      const st = Math.sin(tilt);
      const y2 = y * ct - z1 * st;
      const z2 = y * st + z1 * ct;
      return { x: cx + x1 * R, y: cy - y2 * R, z: z2 };
    };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const halo = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.25);
      halo.addColorStop(0, "rgba(120,90,255,0.10)");
      halo.addColorStop(1, "rgba(120,90,255,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, width, height);
      for (const p of pts) {
        const q = project(p);
        if (q.z < 0) continue;
        ctx.fillStyle = `rgba(200,186,255,${0.16 + q.z * 0.62})`;
        ctx.fillRect(q.x, q.y, 1.6, 1.6);
      }
      // arc between the two cities
      const a = cities[0]!.p;
      const b = cities[1]!.p;
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const m: [number, number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        const len = Math.hypot(...m);
        const lift = 1 + 0.18 * Math.sin(Math.PI * t);
        const q = project([(m[0] / len) * lift, (m[1] / len) * lift, (m[2] / len) * lift]);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      }
      ctx.strokeStyle = "rgba(255,200,130,0.55)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
      for (const c of cities) {
        const q = project(c.p);
        if (q.z < 0) continue;
        const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, 18);
        g.addColorStop(0, "rgba(255,214,150,0.9)");
        g.addColorStop(1, "rgba(255,159,69,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff4dc";
        ctx.beginPath();
        ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(244,240,255,0.75)";
        ctx.font = "12px Inter Variable, system-ui, sans-serif";
        ctx.fillText(c.name, q.x + 10, q.y - 8);
      }
      // sway around India and Hong Kong so they stay in view
      if (!reduce) rot = -1.65 + 0.55 * Math.sin((performance.now() - t0) / 9000);
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [width, height]);
  return <canvas ref={ref} style={{ width, height, maxWidth: "100%" }} aria-hidden />;
}
