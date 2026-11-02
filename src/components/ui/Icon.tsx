import type { SVGProps } from "react";

const paths = {
  dashboard: "m3 10 9-7 9 7v11h-6v-7H9v7H3Z",
  personal: "M3 6h16v15H3V3h14M16 11h5v5h-5z",
  buckets: "m3 7 9-4 9 4-9 4Zm0 5 9 4 9-4M3 17l9 4 9-4",
  transactions: "M5 3h14v18l-3-2-4 2-4-2-3 2ZM8 8h8M8 12h8M8 16h4",
  scanner: "M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5M7 12h10",
  products: "m3 7 9-4 9 4v10l-9 4-9-4Zm0 0 9 5 9-5M12 12v9M7 5l10 5",
  pos: "M4 7h16v14H4ZM4 7l3-4h10l3 4M8 11a4 4 0 0 0 8 0",
  employees: "M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3M17 4a4 4 0 0 1 0 8m5 9v-3a4 4 0 0 0-3-4M13 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3 8 6 5 7 3 12l2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z",
  income: "m3 17 6-6 4 4 8-10M15 5h6v6",
  expenses: "M2 12h4l3-8 5 16 3-8h5",
  transfer: "M3 7h17m-5-4 5 4-5 4M21 17H4m5-4-5 4 5 4",
  deposit: "M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6",
  withdrawal: "M12 15V3m-4 4 4-4 4 4M4 15v6h16v-6",
  sparkles: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4",
  chevron: "m9 5 7 7-7 7",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  moon: "M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2",
  more: "M5 11h2v2H5Zm6 0h2v2h-2Zm6 0h2v2h-2Z",
  close: "m6 6 12 12M6 18 18 6",
  mic: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M9 21h6",
  speaker: "M4 10v4h3l5 4V6l-5 4H4ZM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11",
  speakerMute: "M4 10v4h3l5 4V6l-5 4H4ZM16 9l6 6m0-6-6 6",
  stop: "M7 7h10v10H7Z",
} as const;
export type IconName = keyof typeof paths;
export default function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}><path d={paths[name]} /></svg>;
}
