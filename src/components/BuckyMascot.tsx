import { forwardRef, useState } from "react";
import BuckySvg from "./Bucky";
import { Bucky3D, type BuckyHandle } from "../features/bucky/Bucky3D";
import type { BuckyMode } from "../features/bucky/BuckyController.js";

export type { BuckyHandle };

interface Props {
  /** "normal" = opaque, coin-free. "savings" = translucent with internal
   * coins — Personal Finance savings goals only. */
  mode?: BuckyMode;
  /** Authoritative goal progress 0–100 from saved records (savings mode). */
  progress?: number | null;
  goalId?: string;
  /** Currency of the displayed goal; used by the SVG fallback only. */
  currency?: string;
  talking?: boolean;
  /** Exact GLB clip to play (overrides emotion). */
  animation?: string;
  emotion?: string;
  label?: string;
  /** Sizing variant: default, "panel", or "row" (see app.css). */
  size?: "panel" | "row";
}

/**
 * The visible Bucky mascot: real 3D Bucky is primary. While the model
 * loads, a neutral placeholder fills the container (not the old mascot);
 * the existing SVG Bucky appears only when the 3D model genuinely fails
 * to load or WebGL is unavailable. Seasonal accessories stay off
 * (accessory "none") — nothing is enabled automatically from the date.
 */
const BuckyMascot = forwardRef<BuckyHandle, Props>(function BuckyMascot(
  {
    mode = "normal",
    progress = null,
    goalId,
    currency,
    talking = false,
    animation,
    emotion,
    label,
    size,
  },
  ref,
) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  return (
    <div className={size ? `bucky-mascot bucky-mascot--${size}` : "bucky-mascot"}>
      <Bucky3D
        ref={ref}
        mode={mode}
        progress={progress ?? 0}
        goalId={goalId}
        talking={talking}
        animation={animation}
        emotion={emotion}
        accessory="none"
        label={label ?? "Bucky, the Bucketa mascot"}
        style={{ width: "100%", height: "100%" }}
        onReady={() => setStatus("ready")}
        onError={() => setStatus("error")}
      />
      {status === "loading" && (
        <div className="bucky-mascot-loading" aria-hidden="true" />
      )}
      {status === "error" && (
        <div className="bucky-mascot-fallback">
          <BuckySvg
            variant={mode === "savings" ? "savings" : "greeting"}
            fillPercent={mode === "savings" ? progress : null}
            currency={currency}
            celebrateKey={0}
          />
        </div>
      )}
    </div>
  );
});

export default BuckyMascot;
