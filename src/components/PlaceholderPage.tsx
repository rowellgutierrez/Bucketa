type Props = {
  title: string;
  milestone: string;
  description: string;
};

export default function PlaceholderPage({ title, milestone, description }: Props) {
  return (
    <section className="page">
      <h1>{title}</h1>
      <div className="card placeholder">
        <p className="badge">Planned for {milestone} — not yet functional</p>
        <p className="muted">{description}</p>
        <p className="muted">
          This is a navigation placeholder from the M0 foundation. No financial
          data is stored or displayed here yet.
        </p>
      </div>
    </section>
  );
}
