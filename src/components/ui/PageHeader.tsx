import type { ReactNode } from "react";

export default function PageHeader({ title, description, eyebrow, actions, className = "" }: { title: string; description?: string; eyebrow?: string; actions?: ReactNode; className?: string }) {
  return <header className={`ui-page-header ${className}`}><div>{eyebrow && <p className="ui-eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="ui-description">{description}</p>}</div>{actions && <div className="ui-header-actions">{actions}</div>}</header>;
}
