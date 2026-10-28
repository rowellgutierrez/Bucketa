import { useEffect, useId, useRef, useState } from "react";
import { currencySymbol } from "../lib/currency";

type Props = {
  /** 0–100 coin fill inside the bucket, or null for no fill. From real records only. */
  fillPercent?: number | null;
  /** ISO 4217 currency of the bucket being displayed; embossed on the coins. */
  currency?: string;
  /** Increment to make Bucky celebrate (e.g. after saving a record or reaching a goal). */
  celebrateKey?: number;
  /** Greeting Bucky waves; savings Bucky stays calmer. */
  variant?: "greeting" | "savings";
  now?: Date;
};

type Season = "christmas" | "halloween" | "valentine" | "newyear" | null;

function seasonFor(date: Date): Season {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (month === 12 && day <= 26) return "christmas";
  if (month === 10 && day >= 24) return "halloween";
  if (month === 2 && day >= 7 && day <= 14) return "valentine";
  if ((month === 12 && day >= 27) || (month === 1 && day <= 2)) return "newyear";
  return null;
}

interface PileCoin {
  cx: number;
  cy: number;
  r: number;
  fill: string;
  opacity?: number;
}

/**
 * Closely packed coin texture over the golden base fill. The coins sit
 * on a unified warm gold base (drawn as a gradient rect), so together
 * they read as abundant accumulated treasure rather than individual
 * scattered coins or a wall of separate coins. Coins never move; the
 * visible amount is set purely by clipping at the current fill level,
 * so any fractional percentage shows proportionally and lower coins
 * stay put as savings grow or shrink.
 */
const PILE_COINS: PileCoin[] = [
  { cx: 112, cy: 302, r: 14, fill: "#FFD34D", opacity: 0.85 },
  { cx: 142, cy: 310, r: 13, fill: "#FFC93C", opacity: 0.7 },
  { cx: 172, cy: 300, r: 15, fill: "#FFE066", opacity: 0.85 },
  { cx: 204, cy: 310, r: 13, fill: "#FFD34D", opacity: 0.7 },
  { cx: 234, cy: 300, r: 14, fill: "#FFC93C", opacity: 0.85 },
  { cx: 118, cy: 278, r: 13, fill: "#FFC93C", opacity: 0.7 },
  { cx: 148, cy: 286, r: 14, fill: "#FFE066", opacity: 0.85 },
  { cx: 180, cy: 276, r: 13, fill: "#FFD34D", opacity: 0.7 },
  { cx: 212, cy: 286, r: 14, fill: "#FFC93C", opacity: 0.85 },
  { cx: 240, cy: 276, r: 12, fill: "#FFD34D", opacity: 0.7 },
  { cx: 122, cy: 254, r: 13, fill: "#FFD34D", opacity: 0.85 },
  { cx: 154, cy: 262, r: 14, fill: "#FFC93C", opacity: 0.7 },
  { cx: 186, cy: 252, r: 13, fill: "#FFE066", opacity: 0.85 },
  { cx: 218, cy: 262, r: 13, fill: "#FFD34D", opacity: 0.7 },
  { cx: 128, cy: 232, r: 12, fill: "#FFE066", opacity: 0.7 },
  { cx: 158, cy: 238, r: 13, fill: "#FFD34D", opacity: 0.85 },
  { cx: 190, cy: 230, r: 12, fill: "#FFC93C", opacity: 0.7 },
  { cx: 220, cy: 238, r: 12, fill: "#FFE066", opacity: 0.85 },
  { cx: 136, cy: 208, r: 12, fill: "#FFC93C", opacity: 0.85 },
  { cx: 166, cy: 214, r: 13, fill: "#FFE066", opacity: 0.7 },
  { cx: 198, cy: 206, r: 12, fill: "#FFD34D", opacity: 0.85 },
  { cx: 226, cy: 214, r: 11, fill: "#FFC93C", opacity: 0.7 },
  { cx: 144, cy: 186, r: 11, fill: "#FFD34D", opacity: 0.7 },
  { cx: 174, cy: 190, r: 12, fill: "#FFC93C", opacity: 0.85 },
  { cx: 204, cy: 184, r: 11, fill: "#FFE066", opacity: 0.7 },
  { cx: 152, cy: 164, r: 11, fill: "#FFE066", opacity: 0.85 },
  { cx: 182, cy: 168, r: 12, fill: "#FFD34D", opacity: 0.7 },
  { cx: 210, cy: 162, r: 10, fill: "#FFC93C", opacity: 0.85 },
];

/**
 * A small rounded mound of coins for the top of the pile, centred on
 * x=180 with its base at the fill level (cy=0). The whole mound scales
 * continuously with progress, so it is only a tiny heap at low savings
 * and a full dome of treasure at 100%.
 */
const MOUND_COINS: PileCoin[] = [
  { cx: 132, cy: -3, r: 12, fill: "#F2B93B" },
  { cx: 156, cy: -5, r: 13, fill: "#FFD34D" },
  { cx: 180, cy: -4, r: 12, fill: "#FFC93C" },
  { cx: 204, cy: -5, r: 13, fill: "#FFD34D" },
  { cx: 228, cy: -3, r: 12, fill: "#E8A81C" },
  { cx: 146, cy: -18, r: 12, fill: "#FFC93C" },
  { cx: 172, cy: -21, r: 13, fill: "#FFE066" },
  { cx: 198, cy: -18, r: 12, fill: "#FFD34D" },
  { cx: 160, cy: -26, r: 11, fill: "#FFD34D" },
  { cx: 186, cy: -28, r: 11, fill: "#FFC93C" },
  { cx: 174, cy: -33, r: 9, fill: "#FFE066" },
];

/**
 * Overflow treasure anchored at the bucket opening (cy=0 is the rim,
 * y=118), drawn back layer first so front coins overlap those behind.
 * It only appears above 85% savings, scaled continuously by how far
 * past 85% progress is: a small mound at 90%, a full rounded pile of
 * stacked coins at 100%. Its base rows overlap the interior heap's
 * top coins, so the two read as one continuous pile of treasure.
 */
const OVERFLOW_COINS: PileCoin[] = [
  { cx: 152, cy: -36, r: 15, fill: "#E8A81C" },
  { cx: 182, cy: -40, r: 16, fill: "#FFC93C" },
  { cx: 210, cy: -34, r: 14, fill: "#FFD34D" },
  { cx: 134, cy: -20, r: 16, fill: "#FFD34D" },
  { cx: 164, cy: -25, r: 17, fill: "#FFE066" },
  { cx: 196, cy: -23, r: 16, fill: "#FFC93C" },
  { cx: 224, cy: -18, r: 15, fill: "#E8A81C" },
  { cx: 122, cy: -4, r: 16, fill: "#FFC93C" },
  { cx: 152, cy: -7, r: 17, fill: "#FFD34D" },
  { cx: 182, cy: -5, r: 16, fill: "#FFE066" },
  { cx: 212, cy: -6, r: 17, fill: "#FFD34D" },
  { cx: 238, cy: -2, r: 14, fill: "#F2B93B" },
];

interface CoinGraphicProps extends PileCoin {
  /** Embossed currency symbol or code; empty shows a neutral emblem. */
  symbol?: string;
  /** Detailed coins carry the symbol/emblem; small texture coins do not. */
  detailed?: boolean;
}

/**
 * One cartoon gold coin: a dark-edged rim, an inset lighter face, a
 * curved light arc, and a soft flattened shadow. Detailed coins carry
 * an embossed currency symbol, or a neutral diamond emblem when no
 * currency symbol is available.
 */
function CoinGraphic({ cx, cy, r, fill, opacity, symbol = "", detailed = false }: CoinGraphicProps) {
  const symbolFontSize =
    symbol.length <= 1 ? r * 0.95 : symbol.length === 2 ? r * 0.68 : r * 0.46;
  return (
    <g opacity={opacity ?? 1}>
      <ellipse cx={cx} cy={cy + r * 0.88} rx={r * 0.82} ry={r * 0.28} fill="#8A5A00" opacity="0.18" />
      <circle cx={cx} cy={cy} r={r} fill="#C8870A" stroke="#8A5A00" strokeWidth="2.2" />
      <circle cx={cx} cy={cy} r={r * 0.82} fill={fill} stroke="#D99A16" strokeWidth="1.2" />
      <circle
        cx={cx}
        cy={cy}
        r={r * 0.62}
        fill="none"
        stroke="#B97E0F"
        strokeWidth="1.1"
        opacity="0.5"
      />
      <path
        d={`M ${cx - r * 0.5} ${cy - r * 0.18} A ${r * 0.68} ${r * 0.68} 0 0 1 ${cx - r * 0.14} ${cy - r * 0.6}`}
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.5"
      />
      {detailed &&
        (symbol ? (
          <>
            <text
              x={cx}
              y={cy + 0.7}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={symbolFontSize}
              fontWeight={800}
              fill="#FFE9A8"
              opacity="0.85"
            >
              {symbol}
            </text>
            <text
              x={cx}
              y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={symbolFontSize}
              fontWeight={800}
              fill="#8A5A00"
            >
              {symbol}
            </text>
          </>
        ) : (
          <path
            d={`M ${cx} ${cy - r * 0.42} L ${cx + r * 0.3} ${cy} L ${cx} ${cy + r * 0.42} L ${cx - r * 0.3} ${cy} Z`}
            fill="none"
            stroke="#8A5A00"
            strokeWidth="1.4"
            opacity="0.75"
          />
        ))}
    </g>
  );
}

/**
 * Bucky, Bucketa's mascot, redrawn as layered SVG from the approved master
 * image (Public/Mascot/bucky-master.png) so eyes, arm, mouth, bucket fill,
 * and accessories animate as separate parts. The master PNG is unchanged.
 */
export default function Bucky({ fillPercent = null, currency, celebrateKey = 0, variant = "greeting", now }: Props) {
  const [celebrating, setCelebrating] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const date = now ?? new Date();
  const hour = date.getHours();
  const sleepy = !celebrating && (hour >= 21 || hour < 6);
  const season = seasonFor(date);
  const pct = fillPercent === null ? null : Math.min(100, Math.max(0, fillPercent));
  // Bucket body interior runs from y=132 (under the rim) to y=326 (bottom).
  const fillY = pct === null ? 326 : 326 - (pct / 100) * 194;
  // Unique clip ids per instance so several Buckys on one page never collide.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const bodyClipId = `bucky-body-${uid}`;
  const fillClipId = `bucky-fill-${uid}`;
  const goldGradientId = `bucky-gold-${uid}`;
  const moundClipId = `bucky-mound-${uid}`;
  // Coin symbols come only from the displayed bucket's currency code.
  const coinSymbol = currency ? currencySymbol(currency) : "";
  // The treasure mound grows continuously with progress: a tiny heap at
  // low savings, full size only as the bucket approaches 100%.
  const moundScale = pct === null ? 0 : 0.3 + 0.7 * (pct / 100);
  // Overflow above the bucket opening begins only past 85%: nothing at
  // or below 85%, then a continuous scale from small at 90% to full
  // size at 100%, including fractional percentages.
  const overflow = pct === null ? 0 : Math.min(1, Math.max(0, (pct - 85) / 15));
  const overflowScale = 0.35 + 0.65 * overflow;

  function celebrate() {
    setCelebrating(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCelebrating(false), 1500);
  }

  useEffect(() => {
    if (celebrateKey > 0) celebrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [celebrateKey]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const stateLabel = celebrating
    ? "Bucky celebrating"
    : sleepy
      ? "Bucky feeling sleepy"
      : pct !== null
        ? `Bucky with bucket ${Math.round(pct)} percent full`
        : "Bucky waving hello";

  return (
    <button
      type="button"
      className="bucky-button"
      onClick={celebrate}
      aria-label={`${stateLabel}. Tap Bucky for a happy bounce.`}
      title="Tap Bucky!"
    >
      <svg
        className={`bucky${celebrating ? " bucky-celebrating" : ""}${sleepy ? " bucky-sleepy" : ""}`}
        viewBox="0 0 360 340"
        role="img"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <clipPath id={bodyClipId}>
            <path d="M78,118 L282,118 L268,266 C262,304 232,326 180,326 C128,326 98,304 92,266 Z" />
          </clipPath>
          {/* Reveals the coin pile from the bottom up to the current fill level. */}
          <clipPath id={fillClipId}>
            <rect x="70" y={fillY} width="220" height={326 - fillY} />
          </clipPath>
          {/* Mound coins may rise inside the bucket and through the
              centre of its opening, but never outside Bucky's outline. */}
          <clipPath id={moundClipId}>
            <path d="M78,118 L282,118 L268,266 C262,304 232,326 180,326 C128,326 98,304 92,266 Z" />
            <ellipse cx="180" cy="96" rx="92" ry="56" />
          </clipPath>
          <linearGradient id={goldGradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFD34D" />
            <stop offset="55%" stopColor="#F2B93B" />
            <stop offset="100%" stopColor="#E89B0C" />
          </linearGradient>
        </defs>

        {/* Handle */}
        <path d="M74,120 C74,18 286,18 286,120" fill="none" stroke="#2E82C8" strokeWidth="14" strokeLinecap="round" />

        {/* Feet */}
        <ellipse cx="132" cy="318" rx="38" ry="14" fill="#2A6CB0" />
        <ellipse cx="228" cy="318" rx="38" ry="14" fill="#2A6CB0" />

        {/* Right arm (down) */}
        <g className="bucky-arm-right">
          <path d="M266,208 C294,222 305,242 301,260" fill="none" stroke="#2A6CB0" strokeWidth="20" strokeLinecap="round" />
          <circle cx="300" cy="268" r="19" fill="#1E88D8" />
        </g>

        {/* Body */}
        <path d="M78,118 L282,118 L268,266 C262,304 232,326 180,326 C128,326 98,304 92,266 Z" fill="#8AC3EC" />

        {/* Back of the bucket opening, behind the treasure: the top
            half of the rim plus the dark opening inside it. The front
            rim is drawn later, after the mound. */}
        <path d="M70,118 A110,22 0 0 1 290,118 Z" fill="#4AA3E0" />
        <ellipse cx="180" cy="114" rx="102" ry="18" fill="#1E6FB8" />
        <ellipse cx="180" cy="115" rx="84" ry="12" fill="#185A96" />

        {/* Golden treasure fill from real savings progress: a warm
            gradient base with closely packed coin texture over it. The
            level is the exact fractional fillY, so every progress
            change shows proportionally; treasure accumulates from the
            bottom and is removed from the top when savings fall. The
            face is drawn later, on top of the gold. */}
        {pct !== null && pct > 0 && (
          <g clipPath={`url(#${bodyClipId})`}>
            <rect
              x="70"
              y={fillY}
              width="220"
              height={326 - fillY}
              fill={`url(#${goldGradientId})`}
            />
            <g clipPath={`url(#${fillClipId})`}>
              {PILE_COINS.map((coin) => (
                <CoinGraphic
                  key={`${coin.cx}-${coin.cy}`}
                  {...coin}
                  symbol={coinSymbol}
                  detailed={coin.r >= 13}
                />
              ))}
            </g>
          </g>
        )}

        {/* Treasure mound on top of the pile, clipped inside the
            bucket and its opening. It scales continuously with
            progress, so at low savings it is only a tiny heap at the
            fill level inside the bucket; at 100% it heaps at the
            opening. Drawn before the front rim, which overlaps its
            base so the treasure visibly sits inside the bucket. The
            face is drawn later and stays fully visible. */}
        {pct !== null && pct > 0 && (
          <g clipPath={`url(#${moundClipId})`}>
            <g transform={`translate(180 ${fillY}) scale(${moundScale}) translate(-180 0)`}>
              {MOUND_COINS.map((coin) => (
                <CoinGraphic
                  key={`${coin.cx}-${coin.cy}`}
                  {...coin}
                  symbol={coinSymbol}
                  detailed
                />
              ))}
            </g>
          </g>
        )}

        {/* Overflow treasure, anchored at the bucket opening rather
            than the fill level. It appears only above 85% savings and
            grows continuously to a full overflowing pile at 100%. Its
            base coins overlap the interior heap's top coins around the
            opening, so the whole pile reads as one continuous mound
            of treasure rising out of the bucket, not a separate
            decoration. Drawn before the front rim, so its base stays
            behind the rim while the upper coins extend above it,
            beneath the handle. */}
        {overflow > 0 && (
          <g clipPath={`url(#${moundClipId})`}>
            <g transform={`translate(180 118) scale(${overflowScale}) translate(-180 0)`}>
              {OVERFLOW_COINS.map((coin) => (
                <CoinGraphic
                  key={`${coin.cx}-${coin.cy}`}
                  {...coin}
                  symbol={coinSymbol}
                  detailed
                />
              ))}
            </g>
          </g>
        )}

        {/* Front rim: the lower half of the rim ellipse, drawn over
            the mound's base. The blue rim stays visible across the
            front while the mound emerges from behind it. Slimmer
            than before so it anchors the pile without hiding it. */}
        <path d="M70,118 A110,16 0 0 0 290,118 Z" fill="#4AA3E0" />
        <path
          d="M78,121 A102,13 0 0 0 282,121"
          fill="none"
          stroke="#2E82C8"
          strokeWidth="2"
          opacity="0.6"
        />

        {/* Left arm (waving) */}
        <g className={`bucky-arm-wave${variant === "greeting" && !sleepy ? " bucky-waving" : ""}`}>
          <path d="M94,208 C64,198 50,180 54,160" fill="none" stroke="#2A6CB0" strokeWidth="20" strokeLinecap="round" />
          <circle cx="54" cy="150" r="20" fill="#1E88D8" />
          <circle cx="70" cy="136" r="10" fill="#1E88D8" />
        </g>

        {/* Cheeks */}
        <ellipse cx="110" cy="234" rx="17" ry="9" fill="#F6A8C1" opacity="0.9" />
        <ellipse cx="250" cy="234" rx="17" ry="9" fill="#F6A8C1" opacity="0.9" />

        {/* Eyes */}
        {sleepy ? (
          <g stroke="#1D4E7E" strokeWidth="5" strokeLinecap="round" fill="none">
            <path d="M116,208 C126,216 148,216 158,208" />
            <path d="M202,208 C212,216 234,216 244,208" />
          </g>
        ) : (
          <g className="bucky-eyes">
            <circle cx="137" cy="205" r="24" fill="#1D4E7E" />
            <circle cx="223" cy="205" r="24" fill="#1D4E7E" />
            <circle cx="129" cy="196" r="7" fill="#fff" />
            <circle cx="215" cy="196" r="7" fill="#fff" />
            <circle cx="146" cy="214" r="3" fill="#fff" />
            <circle cx="232" cy="214" r="3" fill="#fff" />
          </g>
        )}

        {/* Mouth */}
        {sleepy ? (
          <ellipse className="bucky-yawn" cx="180" cy="240" rx="10" ry="13" fill="#1D4E7E" />
        ) : celebrating ? (
          <path d="M158,230 C168,246 192,246 202,230 C192,238 168,238 158,230 Z" fill="#1D4E7E" />
        ) : (
          <path d="M162,232 C170,242 190,242 198,232" fill="none" stroke="#1D4E7E" strokeWidth="5" strokeLinecap="round" />
        )}

        {/* Accessories: sleepy cap at night, otherwise seasonal */}
        {sleepy ? (
          <g className="bucky-cap">
            <path d="M96,104 C110,64 160,48 196,58 C168,72 150,88 142,108 Z" fill="#014184" />
            <circle cx="200" cy="58" r="11" fill="#fff" />
            <path d="M96,104 C118,96 132,100 142,108 C128,114 108,112 96,104 Z" fill="#fff" />
          </g>
        ) : season === "christmas" ? (
          <g>
            <path d="M226,100 L276,52 L286,102 Z" fill="#D64545" />
            <ellipse cx="256" cy="102" rx="32" ry="9" fill="#fff" />
            <circle cx="278" cy="50" r="11" fill="#fff" />
          </g>
        ) : season === "newyear" ? (
          <g>
            <path d="M104,102 L128,44 L158,96 Z" fill="#F2B93B" />
            <circle cx="128" cy="42" r="8" fill="#D64545" />
            <ellipse cx="131" cy="100" rx="28" ry="8" fill="#014184" />
          </g>
        ) : season === "valentine" ? (
          <path
            className="bucky-float"
            d="M52,86 C40,70 58,54 70,66 C82,54 100,70 88,86 C80,96 70,100 70,100 C70,100 60,96 52,86 Z"
            fill="#E85D8A"
          />
        ) : season === "halloween" ? (
          <g>
            <circle cx="308" cy="290" r="19" fill="#EE7B21" />
            <path d="M300,272 C302,264 310,262 314,268" fill="none" stroke="#2E7D32" strokeWidth="4" strokeLinecap="round" />
            <circle cx="301" cy="287" r="2.6" fill="#5B3413" />
            <circle cx="315" cy="287" r="2.6" fill="#5B3413" />
            <path d="M299,297 C304,301 312,301 317,297" fill="none" stroke="#5B3413" strokeWidth="2.5" strokeLinecap="round" />
          </g>
        ) : null}

        {sleepy && (
          <g className="bucky-zzz" fill="#486581" fontWeight="800">
            <text x="262" y="150" fontSize="20">Z</text>
            <text x="278" y="128" fontSize="26">Z</text>
          </g>
        )}
      </svg>
    </button>
  );
}

