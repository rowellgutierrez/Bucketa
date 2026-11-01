import PageHeader from "./ui/PageHeader";
import Icon from "./ui/Icon";

type Props = { title: string; milestone: string; description: string };

export default function PlaceholderPage({ title, description }: Props) {
  return (
    <section className="page planned-page">
      <PageHeader className="workspace-page-header" eyebrow="YOUR WORKSPACE" title={title} />
      <div className="card placeholder planned-state">
        <span className="metric-icon"><Icon name={title.startsWith("Employees") ? "employees" : "settings"} /></span>
        <p className="badge">Planned · not yet available</p>
        <h2>{title.startsWith("Employees") ? "Your team, in one place" : "Make Bucketa your own"}</h2>
        <p className="muted">{description}</p>
        <p className="field-hint">This feature is not functional yet. No records can be created or changed here.</p>
        <a className="btn ghost" href="#/dashboard">Back to Home</a>
      </div>
    </section>
  );
}
