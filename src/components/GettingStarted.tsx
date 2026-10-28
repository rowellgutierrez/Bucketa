export interface StartStep {
  title: string;
  text: string;
  cta?: string;
  href?: string;
  onAction?: () => void;
}

type Props = {
  title: string;
  intro: string;
  steps: StartStep[];
  /** Render collapsed so returning users can open it only when wanted. */
  collapsed?: boolean;
};

/**
 * Contextual getting-started guidance. Callers build `steps` only from
 * records that are actually missing, so existing profiles, buckets, and
 * transactions are never suggested again. No financial data is shown here.
 */
export default function GettingStarted({ title, intro, steps, collapsed = false }: Props) {
  if (steps.length === 0) return null;
  const body = (
    <>
      <p className="muted getting-intro">{intro}</p>
      <ol className="steps-list">
        {steps.map((step) => (
          <li key={step.title} className="step-row">
            <div className="step-main">
              <strong>{step.title}</strong>
              <p className="muted bucket-meta">{step.text}</p>
            </div>
            {step.cta &&
              (step.href ? (
                <a className="btn ghost small dash-anchor" href={step.href}>
                  {step.cta}
                </a>
              ) : step.onAction ? (
                <button className="btn ghost small" type="button" onClick={step.onAction}>
                  {step.cta}
                </button>
              ) : null)}
          </li>
        ))}
      </ol>
      <p className="muted getting-note">
        No account or sign-up needed. Bucketa only summarises records you enter,
        and your data stays in this browser.
      </p>
    </>
  );

  if (collapsed) {
    return (
      <details className="panel getting-started">
        <summary>{title}</summary>
        {body}
      </details>
    );
  }

  return (
    <section className="panel getting-started" aria-label={title}>
      <h2 className="getting-title">{title}</h2>
      {body}
    </section>
  );
}
