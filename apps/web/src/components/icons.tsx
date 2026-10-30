import type { SVGProps } from "react";

/** Stroke icons: 1.5px, outlined, round joins. One set across the site. */
type P = SVGProps<SVGSVGElement> & { size?: number };

const base = (size = 24, rest: SVGProps<SVGSVGElement>) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...rest,
});

export const IconIou = (p: P) => (
  <svg {...base(p.size ?? 40, p)}>
    <path d="M6 3.75h9l3 3V20.25H6z" />
    <path d="M15 3.75v3h3" />
    <path d="M9 11h6M9 14h4" />
    <path d="M9.5 17.5c.8-.9 1.6-.9 2.2 0 .6.9 1.4.9 2.3 0" />
  </svg>
);

export const IconNet = (p: P) => (
  <svg {...base(p.size ?? 40, p)}>
    <circle cx="5" cy="6" r="1.75" />
    <circle cx="5" cy="18" r="1.75" />
    <circle cx="19" cy="6" r="1.75" />
    <circle cx="19" cy="18" r="1.75" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6.4 7.2 10 10.3M17.6 7.2 14 10.3M6.4 16.8 10 13.7M17.6 16.8 14 13.7" />
  </svg>
);

export const IconHsp = (p: P) => (
  <svg {...base(p.size ?? 40, p)}>
    <path d="M12 3 4.5 6v5.5c0 4.2 3.1 8 7.5 9.5 4.4-1.5 7.5-5.3 7.5-9.5V6z" />
    <path d="m8.75 12 2.25 2.25 4.25-4.5" />
  </svg>
);

export const IconVault = (p: P) => (
  <svg {...base(p.size ?? 40, p)}>
    <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2" />
    <circle cx="12" cy="12" r="3.25" />
    <path d="M12 8.75v-1M12 16.25v-1M15.25 12h1M7.75 12h1M3.75 9h-1M3.75 15h-1" />
  </svg>
);

export const IconScale = (p: P) => (
  <svg {...base(p.size ?? 40, p)}>
    <path d="M12 4v16M7 20h10M5 7h14" />
    <path d="M5 7 2.75 13a2.5 2.5 0 0 0 4.5 0zM19 7l-2.25 6a2.5 2.5 0 0 0 4.5 0z" />
  </svg>
);

export const IconStar = (p: P) => (
  <svg {...base(p.size ?? 40, p)}>
    <path d="m12 3.5 2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z" />
  </svg>
);

export const IconAmber = (p: P) => (
  <svg {...base(p.size ?? 40, p)}>
    <path d="M12 2.75 19.25 7v10L12 21.25 4.75 17V7z" />
    <path d="M12 8.25 15.25 10v4L12 15.75 8.75 14v-4z" />
    <path d="M12 2.75v5.5M19.25 7l-4 3M4.75 7l4 3M12 21.25v-5.5" />
  </svg>
);

export const IconIntent = (p: P) => (
  <svg {...base(p.size ?? 40, p)}>
    <path d="M5 20.25c4-1 6-4 6.5-8.5" />
    <path d="M14.5 4.25 19.75 9.5l-7.5 7.5-5.25-5.25z" />
    <path d="m17 7 2.75-2.75" />
  </svg>
);

export const IconSearch = (p: P) => (
  <svg {...base(p.size ?? 24, p)}>
    <circle cx="11" cy="11" r="6.25" />
    <path d="m20 20-4.5-4.5" />
  </svg>
);

export const IconFilter = (p: P) => (
  <svg {...base(p.size ?? 24, p)}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </svg>
);

export const IconChevron = (p: P) => (
  <svg {...base(p.size ?? 16, p)} viewBox="0 0 16 16">
    <path d="m6 4 4 4-4 4" />
  </svg>
);

export const IconArrow = (p: P) => (
  <svg {...base(p.size ?? 16, p)} viewBox="0 0 16 16">
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
);

export const IconExternal = (p: P) => (
  <svg {...base(p.size ?? 14, p)} viewBox="0 0 16 16">
    <path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5v3a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3" />
  </svg>
);

export const IconPlay = (p: P) => (
  <svg {...base(p.size ?? 24, p)} fill="currentColor" stroke="none">
    <path d="M8 5.6v12.8a.8.8 0 0 0 1.2.7l10.3-6.4a.8.8 0 0 0 0-1.4L9.2 4.9A.8.8 0 0 0 8 5.6Z" />
  </svg>
);

export const IconLock = (p: P) => (
  <svg {...base(p.size ?? 24, p)}>
    <rect x="5" y="10.5" width="14" height="9.75" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </svg>
);

export const IconCheck = (p: P) => (
  <svg {...base(p.size ?? 16, p)} viewBox="0 0 16 16">
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
);

export const IconX = (p: P) => (
  <svg {...base(p.size ?? 16, p)} viewBox="0 0 16 16">
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);

export const IconGithub = (p: P) => (
  <svg width={p.size ?? 20} height={p.size ?? 20} viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.4c.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .5Z" />
  </svg>
);

export const IconRadar = (p: P) => (
  <svg {...base(p.size ?? 24, p)}>
    <circle cx="12" cy="12" r="8.25" />
    <circle cx="12" cy="12" r="4.25" />
    <path d="M12 12 18 6" />
  </svg>
);

export const IconChart = (p: P) => (
  <svg {...base(p.size ?? 24, p)}>
    <path d="M4 20V4M4 20h16" />
    <path d="M8 16v-4M12 16V8M16 16v-6" />
  </svg>
);

export const IconGlobe = (p: P) => (
  <svg {...base(p.size ?? 24, p)}>
    <circle cx="12" cy="12" r="8.25" />
    <path d="M3.75 12h16.5M12 3.75c2.5 2.6 3.5 5.3 3.5 8.25s-1 5.65-3.5 8.25c-2.5-2.6-3.5-5.3-3.5-8.25S9.5 6.35 12 3.75Z" />
  </svg>
);

export const IconBolt = (p: P) => (
  <svg {...base(p.size ?? 24, p)}>
    <path d="M13 3 5 13.5h6L10.5 21 19 10.5h-6z" />
  </svg>
);

export const IconCode = (p: P) => (
  <svg {...base(p.size ?? 24, p)}>
    <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13" />
  </svg>
);

export const IconCopy = (p: P) => (
  <svg {...base(p.size ?? 14, p)} viewBox="0 0 16 16">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5v-.5A1 1 0 0 0 9.5 2h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" />
  </svg>
);

export const IconClock = (p: P) => (
  <svg {...base(p.size ?? 16, p)}>
    <circle cx="12" cy="12" r="8.25" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const IconChain = (p: P) => (
  <svg {...base(p.size ?? 16, p)}>
    <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-.75.75" />
    <path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l.75-.75" />
  </svg>
);
