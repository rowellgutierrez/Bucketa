import type { HTMLAttributes, ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

export default function Card({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`ui-card ${className}`} {...props} />;
}
export function MetricCard({ label, value, detail, icon }: { label: string; value: ReactNode; detail?: string; icon: IconName }) {
  return <Card className="metric-card"><span className="metric-icon"><Icon name={icon} /></span><dl><dt>{label}</dt><dd>{value}</dd></dl>{detail && <p>{detail}</p>}</Card>;
}
