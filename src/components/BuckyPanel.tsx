import { useEffect, useMemo, useState } from "react";
import type { Bucket, Product, Profile, Sale, Transaction } from "../data/types.ts";
import {
  analyzeBuckyFinances,
  answerBuckyQuestion,
  buildBuckyModelSummary,
  type BuckyAnswer,
  type BuckyProposal,
} from "../lib/buckyAgent.ts";
import { BuckyApiError, requestBuckyAdvice, type BuckyAdviceResponse } from "../lib/buckyApi.ts";
import Bucky from "./Bucky.tsx";

interface Props {
  profiles: Profile[];
  buckets: Bucket[];
  transactions: Transaction[];
  products: Product[];
  sales: Sale[];
  /** Profile the surrounding dashboard view is focused on, when known. */
  preferredProfileId?: string;
}

const QUESTIONS = [
  "Why are my expenses increasing?",
  "Do I have any duplicates?",
  "What is low on stock?",
  "How is my savings goal doing?",
  "How much POS revenue did I make?",
  "Give me a cash flow overview",
];

/** Navigation is the only thing a Bucky proposal can ever do. */
function goToProposal(proposal: BuckyProposal) {
  if (proposal.action.type === "scan") {
    window.location.hash = "/scanner";
    return;
  }
  window.location.hash = `/${proposal.action.route.replace(/^\//, "")}`;
}

function goToRoute(route: string) {
  window.location.hash = `/${route.replace(/^\//, "")}`;
}

/**
 * Bucky Agent panel: deterministic financial intelligence calculated in
 * code from the selected profile's saved records. This is NOT Meta AI
 * and makes no model call; every figure can be traced to stored records.
 * Bucky only proposes navigation — it never creates, edits, or deletes
 * financial data.
 */
export default function BuckyPanel({ profiles, buckets, transactions, products, sales, preferredProfileId }: Props) {
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<BuckyAnswer | null>(null);
  const [advisor, setAdvisor] = useState<BuckyAdviceResponse | null>(null);
  const [advisorBusy, setAdvisorBusy] = useState(false);
  const [advisorError, setAdvisorError] = useState("");
  const [useLiveMeta, setUseLiveMeta] = useState(false);
  // Runtime only: never persisted, logged, or pre-filled.
  const [liveToken, setLiveToken] = useState("");

  // Follow the dashboard's focused profile until the user picks another.
  useEffect(() => {
    if (preferredProfileId && profiles.some((p) => p.id === preferredProfileId)) {
      setSelectedProfileId(preferredProfileId);
    }
  }, [preferredProfileId, profiles]);

  const profile =
    profiles.find((p) => p.id === selectedProfileId) ??
    profiles.find((p) => p.kind === "personal") ??
    profiles[0];

  const result = useMemo(() => {
    if (!profile) return null;
    try {
      return {
        analysis: analyzeBuckyFinances({ profile, buckets, transactions, products, sales }),
        error: "",
      };
    } catch {
      return { analysis: null, error: "Bucky could not analyse these records. Your records themselves were not changed." };
    }
  }, [profile, buckets, transactions, products, sales]);

  const analysis = result?.analysis ?? null;

  function ask(text: string) {
    const q = text.trim();
    if (!q || !analysis) return;
    setQuestion(q);
    setAnswer(answerBuckyQuestion(q, analysis));
  }

  async function askAdvisor() {
    const q = question.trim();
    if (!q || !analysis || advisorBusy) return;
    setAdvisorBusy(true);
    setAdvisorError("");
    setAdvisor(null);
    try {
      // Only aggregated totals/counts leave the browser — never raw records.
      const summary = buildBuckyModelSummary(analysis);
      const res = await requestBuckyAdvice(q, summary, {
        mode: useLiveMeta ? "live" : "fallback",
        liveTestToken: useLiveMeta ? liveToken : undefined,
      });
      setAdvisor(res);
    } catch (error) {
      setAdvisorError(
        error instanceof BuckyApiError
          ? error.message
          : "The Bucky advisor request could not be completed. Your calculated answer above still applies.",
      );
    } finally {
      setAdvisorBusy(false);
    }
  }

  return (
    <section className="panel bucky-panel" aria-labelledby="bucky-panel-heading">
      <div className="bucky-panel-head">
        <Bucky variant="savings" />
        <div>
          <h2 id="bucky-panel-heading">Bucky Agent</h2>
          <p className="muted">
            Calculated from your saved records — deterministic analysis, not AI-generated.
            Bucky can suggest where to look, but it never changes your data.
          </p>
        </div>
      </div>

      {profiles.length === 0 ? (
        <div className="empty-state">
          <p>No profile to analyse yet.</p>
          <p className="muted">Create a personal profile or a business first, then Bucky can analyse its records.</p>
          <div className="row-actions">
            <a className="btn ghost small" href="#/personal">Set up a profile</a>
          </div>
        </div>
      ) : result?.error ? (
        <p className="alert-error" role="alert">{result.error}</p>
      ) : analysis ? (
        <>
          {profiles.length > 1 && (
            <div className="selector-main bucky-profile-row">
              <label htmlFor="bucky-profile">Analysing</label>
              <select
                id="bucky-profile"
                className="input selector-select"
                value={profile?.id ?? ""}
                onChange={(e) => {
                  setSelectedProfileId(e.target.value);
                  setAnswer(null);
                  setAdvisor(null);
                  setAdvisorError("");
                }}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.kind === "business" ? "Business" : "Personal"})
                  </option>
                ))}
              </select>
            </div>
          )}

          {!analysis.hasAnyData ? (
            <div className="empty-state">
              <p>No records to analyse for {analysis.profileName} yet.</p>
              <p className="muted">
                Add a record manually or scan a handwritten record. Bucky only
                analyses real saved records and never invents data.
              </p>
            </div>
          ) : (
            <ul className="bucky-insights">
              {analysis.insights.map((insight) => {
                const proposal = insight.proposalId
                  ? analysis.proposals.find((p) => p.id === insight.proposalId)
                  : undefined;
                return (
                  <li key={insight.id} className={`bucky-insight bucky-${insight.severity}`}>
                    <strong>{insight.title}</strong>
                    <p>{insight.detail}</p>
                    {insight.evidence.length > 0 && (
                      <dl className="bucky-evidence">
                        {insight.evidence.map((e) => (
                          <div key={`${e.label}-${e.value}`}>
                            <dt>{e.label}</dt>
                            <dd>{e.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {proposal && (
                      <button className="btn ghost small" type="button" onClick={() => goToProposal(proposal)}>
                        {proposal.action.label}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <form
            className="bucky-ask"
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
          >
            <label htmlFor="bucky-question">Ask Bucky about {analysis.profileName}</label>
            <div className="bucky-ask-row">
              <input
                id="bucky-question"
                className="input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Why are my expenses increasing?"
                autoComplete="off"
              />
              <button className="btn" type="submit" disabled={!question.trim()}>Ask</button>
            </div>
            <div className="bucky-chips" role="group" aria-label="Suggested questions">
              {QUESTIONS.map((q) => (
                <button key={q} className="btn ghost small" type="button" onClick={() => ask(q)}>
                  {q}
                </button>
              ))}
            </div>
          </form>

          {answer && (
            <div className="bucky-answer" role="status">
              <p>{answer.answer}</p>
              {answer.facts.length > 0 && (
                <dl className="bucky-evidence">
                  {answer.facts.map((f) => (
                    <div key={`${f.label}-${f.value}`}>
                      <dt>{f.label}</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {answer.proposalIds.map((id) => {
                const proposal = analysis.proposals.find((p) => p.id === id);
                return proposal ? (
                  <button key={id} className="btn ghost small" type="button" onClick={() => goToProposal(proposal)}>
                    {proposal.action.label}
                  </button>
                ) : null;
              })}
            </div>
          )}

          <div className="bucky-advisor">
            <h3>Meta-powered Bucky</h3>
            <p className="muted">
              Sends only aggregated totals for {analysis.profileName} to the local
              Bucketa server — never raw records. Live Meta answers require the
              server's live gates and a runtime token; otherwise the server
              returns a clearly labelled calculated fallback.
            </p>
            <label className="bucky-live-toggle">
              <input
                type="checkbox"
                checked={useLiveMeta}
                onChange={(e) => setUseLiveMeta(e.target.checked)}
              />
              Request a live Meta answer
            </label>
            {useLiveMeta && (
              <div className="field">
                <label htmlFor="bucky-live-token">Live test token (runtime only, never saved)</label>
                <input
                  id="bucky-live-token"
                  className="input"
                  type="password"
                  value={liveToken}
                  onChange={(e) => setLiveToken(e.target.value)}
                  autoComplete="off"
                  placeholder="Token from the local server operator"
                />
              </div>
            )}
            <div className="row-actions">
              <button
                className="btn"
                type="button"
                onClick={() => void askAdvisor()}
                disabled={advisorBusy || !question.trim() || (useLiveMeta && !liveToken.trim())}
              >
                {advisorBusy ? "Asking Bucky advisor…" : "Ask Bucky advisor"}
              </button>
            </div>
            {advisorBusy && <p className="muted" role="status">Contacting the Bucky advisor…</p>}
            {advisorError && <p className="alert-error" role="alert">{advisorError}</p>}
            {advisor && (
              <div className="bucky-answer" role="status">
                <p>
                  <span className="currency-badge">
                    {advisor.source === "meta-live"
                      ? `Meta AI${advisor.model ? ` · ${advisor.model}` : ""}`
                      : "Deterministic fallback — not Meta AI"}
                  </span>
                </p>
                <p>{advisor.answer}</p>
                {advisor.diagnostic && (
                  <p className="muted">
                    Live diagnostic: {advisor.diagnostic.category}
                    {advisor.diagnostic.subReason ? ` / ${advisor.diagnostic.subReason}` : ""}
                    {advisor.diagnostic.upstreamStatus ? ` (HTTP ${advisor.diagnostic.upstreamStatus})` : ""}
                  </p>
                )}
                <p className="muted">{advisor.explanation}</p>
                {advisor.evidence.length > 0 && (
                  <dl className="bucky-evidence">
                    {advisor.evidence.map((f) => (
                      <div key={`${f.label}-${f.value}`}>
                        <dt>{f.label}</dt>
                        <dd>{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {advisor.suggestedActions.length > 0 && (
                  <div className="row-actions">
                    {advisor.suggestedActions.map((a) => (
                      <button key={a.id} className="btn ghost small" type="button" onClick={() => goToRoute(a.route)}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
                {advisor.limitations.length > 0 && (
                  <ul className="bucky-advisor-limitations">
                    {advisor.limitations.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <details className="bucky-limitations">
            <summary>How Bucky calculates this</summary>
            <ul>
              {analysis.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
    </section>
  );
}
