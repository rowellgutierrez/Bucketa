import { useEffect, useRef, useState, type FormEvent } from "react";
import PageHeader from "../components/ui/PageHeader";
import {
  createTransactionConfirmed,
  employeesRepo,
  profilesRepo,
  transactionsRepo,
} from "../data/db";
import type { Employee, Profile, SalaryFrequency, Transaction } from "../data/types";
import { newId, nowIso, validateEmployee, validateTransaction } from "../data/validation";
import { DEFAULT_LOCALE } from "../config";
import {
  formatMoney,
  minorUnitsToAmountInput,
  parseAmountToMinorUnits,
} from "../lib/currency";
import { isValidCalendarDate } from "../lib/recordForm";
import {
  buildCompensationTransaction,
  businessCompensationSummary,
  employeeOptionLabel,
  monthlyCompensation,
  paymentsForEmployee,
  summarizeEmployeePayments,
  COMPENSATION_LABELS,
  type CompensationType,
} from "../lib/employees";
import { onRecordsChanged } from "../lib/dataChange";

type Status = "loading" | "ready" | "error";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function todayInputValue(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: "medium" }).format(date);
}

function monthLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00`);
  return Number.isNaN(date.getTime())
    ? month
    : new Intl.DateTimeFormat(DEFAULT_LOCALE, { month: "short", year: "numeric" }).format(date);
}

const FREQUENCIES: { value: SalaryFrequency; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

/**
 * Employees & Salaries: employee records plus confirmed salary, bonus,
 * and advance payments. Each payment is exactly one business expense
 * transaction linked to the employee; confirming twice can never create
 * a second expense (stable preview ID + commit-confirmed save). Salary
 * rates are agreements shown on the record — never expenses. Archiving
 * (status "inactive") preserves all payment history and can be undone.
 * This is recorded salary spending, not payroll: no taxes, deductions,
 * payslips, or unpaid-liability calculations are claimed.
 */
export default function EmployeesPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [loadError, setLoadError] = useState("");
  const [businesses, setBusinesses] = useState<Profile[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [notice, setNotice] = useState("");
  const [pageError, setPageError] = useState("");

  // Employee form
  const [showEmployeeForm, setShowEmployeeForm] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [empStatus, setEmpStatus] = useState<"active" | "inactive">("active");
  const [startDate, setStartDate] = useState("");
  const [contact, setContact] = useState("");
  const [rate, setRate] = useState("");
  const [frequency, setFrequency] = useState<SalaryFrequency | "">("");
  const [savingEmployee, setSavingEmployee] = useState(false);
  const [employeeError, setEmployeeError] = useState("");

  // Payment form
  const [paymentEmployeeId, setPaymentEmployeeId] = useState("");
  const [paymentType, setPaymentType] = useState<CompensationType>("salary");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayInputValue());
  const [paymentNote, setPaymentNote] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [pendingPayment, setPendingPayment] = useState<Transaction | null>(null);
  const [savingPayment, setSavingPayment] = useState(false);
  const executedPaymentIds = useRef<Set<string>>(new Set());

  // History selection
  const [historyEmployeeId, setHistoryEmployeeId] = useState("");

  const business = businesses.find((b) => b.id === businessId) ?? businesses[0];

  async function loadBusinessData(forId: string) {
    const [emps, txns] = await Promise.all([
      employeesRepo.listByProfile(forId),
      transactionsRepo.listByProfile(forId),
    ]);
    setEmployees([...emps].sort((a, b) => a.name.localeCompare(b.name)));
    setTransactions(txns);
  }

  async function load() {
    setStatus("loading");
    setLoadError("");
    try {
      const all = await profilesRepo.listAll();
      const biz = all.filter((p) => p.kind === "business");
      setBusinesses(biz);
      const first = biz[0];
      if (first) {
        setBusinessId((prev) => (biz.some((b) => b.id === prev) ? prev : first.id));
        await loadBusinessData(biz.some((b) => b.id === businessId) ? businessId : first.id);
      }
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setLoadError(errorMessage(error));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A confirmed Bucky salary/bonus/advance save refreshes this business's
  // employees and payments in place (selection by employee ID is kept).
  useEffect(() => {
    if (!businessId) return;
    return onRecordsChanged(() => {
      void loadBusinessData(businessId).catch(() => {
        // Keep the last loaded records if a refresh fails.
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  async function switchBusiness(id: string) {
    setBusinessId(id);
    setNotice("");
    setPageError("");
    setPendingPayment(null);
    setHistoryEmployeeId("");
    try {
      await loadBusinessData(id);
    } catch (error) {
      setPageError(errorMessage(error));
    }
  }

  function resetEmployeeForm() {
    setEditingId("");
    setName("");
    setRole("");
    setEmpStatus("active");
    setStartDate("");
    setContact("");
    setRate("");
    setFrequency("");
    setEmployeeError("");
  }

  function startEdit(employee: Employee) {
    setEditingId(employee.id);
    setName(employee.name);
    setRole(employee.role ?? "");
    setEmpStatus(employee.status);
    setStartDate(employee.startDate ?? "");
    setContact(employee.contact ?? "");
    setRate(
      employee.salaryRateMinor
        ? minorUnitsToAmountInput(employee.salaryRateMinor, employee.currency ?? business?.currency ?? "PHP")
        : "",
    );
    setFrequency(employee.salaryFrequency ?? "");
    setEmployeeError("");
    setShowEmployeeForm(true);
  }

  async function onSaveEmployee(event: FormEvent) {
    event.preventDefault();
    if (!business) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setEmployeeError("Name is required.");
      return;
    }
    if (startDate && !isValidCalendarDate(startDate)) {
      setEmployeeError("Enter a valid start date.");
      return;
    }
    let rateMinor: number | null = null;
    if (rate.trim()) {
      try {
        rateMinor = parseAmountToMinorUnits(rate, business.currency);
        if (rateMinor < 0) throw new Error("Rate cannot be negative.");
      } catch (error) {
        setEmployeeError(`Salary rate: ${errorMessage(error)}`);
        return;
      }
    }
    if (savingEmployee) return;
    setSavingEmployee(true);
    try {
      const editing = employees.find((e) => e.id === editingId);
      if (editing) {
        const updated = await employeesRepo.update(editing.id, {
          name: trimmed,
          role: role.trim() || null,
          status: empStatus,
          startDate: startDate || null,
          contact: contact.trim() || null,
          salaryRateMinor: rateMinor,
          salaryFrequency: frequency || null,
          currency: business.currency,
        });
        setEmployees((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
        setNotice(`“${updated.name}” updated.`);
      } else {
        const stamp = nowIso();
        const employee: Employee = {
          id: newId(),
          profileId: business.id,
          name: trimmed,
          role: role.trim() || null,
          status: empStatus,
          startDate: startDate || null,
          contact: contact.trim() || null,
          salaryRateMinor: rateMinor,
          salaryFrequency: frequency || null,
          currency: business.currency,
          createdAt: stamp,
          updatedAt: stamp,
        };
        validateEmployee(employee);
        await employeesRepo.create(employee);
        setEmployees((prev) => [...prev, employee].sort((a, b) => a.name.localeCompare(b.name)));
        setNotice(`“${employee.name}” added.`);
      }
      resetEmployeeForm();
      setShowEmployeeForm(false);
    } catch (error) {
      setEmployeeError(errorMessage(error));
    } finally {
      setSavingEmployee(false);
    }
  }

  async function onToggleArchive(employee: Employee) {
    try {
      const updated = await employeesRepo.update(employee.id, {
        status: employee.status === "active" ? "inactive" : "active",
      });
      setEmployees((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
      setNotice(
        updated.status === "inactive"
          ? `“${updated.name}” archived. Payment history is preserved.`
          : `“${updated.name}” restored.`,
      );
    } catch (error) {
      setPageError(errorMessage(error));
    }
  }

  function onPreviewPayment(event: FormEvent) {
    event.preventDefault();
    if (!business) return;
    const employee = employees.find((e) => e.id === paymentEmployeeId);
    if (!employee) {
      setPaymentError("Choose an employee first.");
      return;
    }
    if (!isValidCalendarDate(paymentDate)) {
      setPaymentError("Enter a valid payment date.");
      return;
    }
    let amountMinor: number;
    try {
      amountMinor = parseAmountToMinorUnits(paymentAmount, business.currency);
      if (amountMinor <= 0) throw new Error("Amount must be greater than zero.");
    } catch (error) {
      setPaymentError(errorMessage(error));
      return;
    }
    setPaymentError("");
    // The preview builds the exact transaction, with its stable ID, that
    // Confirm will save. Nothing is written yet.
    setPendingPayment(
      buildCompensationTransaction({
        id: `salary:${newId()}`,
        employee,
        type: paymentType,
        amountMinor,
        currency: business.currency,
        date: paymentDate,
        note: paymentNote,
        timestamp: nowIso(),
      }),
    );
  }

  async function onConfirmPayment() {
    if (!pendingPayment || savingPayment) return;
    if (executedPaymentIds.current.has(pendingPayment.id)) {
      setPaymentError("This payment was already saved. It won't be saved again.");
      return;
    }
    setSavingPayment(true);
    try {
      validateTransaction(pendingPayment);
      await createTransactionConfirmed(pendingPayment);
      executedPaymentIds.current.add(pendingPayment.id);
      setTransactions((prev) => [pendingPayment, ...prev]);
      const employee = employees.find((e) => e.id === pendingPayment.relatedId);
      setNotice(
        `${COMPENSATION_LABELS[paymentType]} payment of ${formatMoney(pendingPayment.amountMinor, pendingPayment.currency)} recorded for ${employee?.name ?? "the employee"}.`,
      );
      setPendingPayment(null);
      setPaymentAmount("");
      setPaymentNote("");
      setPaymentError("");
      if (pendingPayment.relatedId) setHistoryEmployeeId(pendingPayment.relatedId);
    } catch (error) {
      setPaymentError(`${errorMessage(error)} Nothing was saved.`);
    } finally {
      setSavingPayment(false);
    }
  }

  const summaries = summarizeEmployeePayments(employees, transactions);
  const summaryFor = (id: string) => summaries.find((s) => s.employeeId === id);
  const businessSummary = business ? businessCompensationSummary(transactions, business.id) : [];
  const months = business ? monthlyCompensation(transactions, business.id, business.currency).slice(-6) : [];
  const historyEmployee = employees.find((e) => e.id === historyEmployeeId) ?? employees[0];
  const history = historyEmployee ? paymentsForEmployee(transactions, historyEmployee) : [];

  return (
    <section className="page finance-page employees-page">
      <PageHeader
        className="workspace-page-header"
        eyebrow="BUSINESS TOOLS"
        title="Employees and Salaries"
        description="Employee records and confirmed salary, bonus, and advance payments — recorded as business expenses."
      />

      {status === "loading" && <div className="card loading-state" role="status">Loading employees…</div>}
      {status === "error" && (
        <div className="card feedback-error">
          <p className="alert-error" role="alert">Could not load employees: {loadError}</p>
          <button className="btn" type="button" onClick={() => void load()}>Retry</button>
        </div>
      )}

      {status === "ready" && businesses.length === 0 && (
        <div className="card empty-state">
          <h2>Employees belong to a business</h2>
          <p className="muted">
            Create a business in <a href="#/buckets">Buckets</a> first, then add your employees here.
          </p>
        </div>
      )}

      {status === "ready" && business && (
        <>
          <div className="selector-bar">
            <div className="selector-main">
              <label htmlFor="employees-business">Business</label>
              <select
                id="employees-business"
                className="input selector-select"
                value={business.id}
                onChange={(e) => void switchBusiness(e.target.value)}
              >
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <span className="muted selector-meta">
                {business.currency} · {employees.filter((e) => e.status === "active").length} active · {employees.length} total
              </span>
            </div>
            <button className="btn" type="button" onClick={() => { resetEmployeeForm(); setShowEmployeeForm((v) => !v); }}>
              {showEmployeeForm ? "Close form" : "Add employee"}
            </button>
          </div>

          {notice && <p className="notice dash-alert" role="status">{notice}</p>}
          {pageError && <p className="alert-error dash-alert" role="alert">{pageError}</p>}

          {businessSummary.length > 0 && (
            <section className="panel" aria-labelledby="comp-summary-heading">
              <div className="panel-head"><h2 id="comp-summary-heading">Recorded salary spending</h2></div>
              {businessSummary.map((s) => (
                <div key={s.currency}>
                  <dl className="bucky-evidence">
                    <div><dt>Salary</dt><dd>{formatMoney(s.salaryMinor, s.currency)}</dd></div>
                    <div><dt>Bonuses</dt><dd>{formatMoney(s.bonusMinor, s.currency)}</dd></div>
                    <div><dt>Advances</dt><dd>{formatMoney(s.advanceMinor, s.currency)}</dd></div>
                    <div><dt>Payments</dt><dd>{s.paymentCount}</dd></div>
                    {s.percentOfIncome !== null && (
                      <div><dt>Share of recorded income</dt><dd>{s.percentOfIncome.toFixed(0)}%</dd></div>
                    )}
                  </dl>
                  <p className="muted">
                    Recorded payments compared with recorded income only. This is salary spending, not a
                    payroll calculation — Bucketa does not compute taxes, deductions, or amounts still owed,
                    and recorded cash flow is not profit.
                  </p>
                </div>
              ))}
              {months.length > 0 && (
                <ul className="bucky-insights">
                  {months.map((m) => (
                    <li key={m.month} className="bucky-insight bucky-info">
                      <strong>{monthLabel(m.month)}</strong>
                      <p>
                        Salary {formatMoney(m.salaryMinor, business.currency)} · Bonuses{" "}
                        {formatMoney(m.bonusMinor, business.currency)} · Advances{" "}
                        {formatMoney(m.advanceMinor, business.currency)} · {m.count} payment{m.count === 1 ? "" : "s"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {showEmployeeForm && (
            <form className="card inline-form" onSubmit={onSaveEmployee} noValidate>
              <h2 className="inline-form-title">{editingId ? "Edit employee" : "Add employee"}</h2>
              <div className="field">
                <label htmlFor="emp-name">Name</label>
                <input id="emp-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="emp-role">Position</label>
                <input id="emp-role" className="input" value={role} onChange={(e) => setRole(e.target.value)} autoComplete="off" placeholder="e.g. Cashier" />
              </div>
              <div className="field">
                <label htmlFor="emp-status">Employment status</label>
                <select id="emp-status" className="input" value={empStatus} onChange={(e) => setEmpStatus(e.target.value as "active" | "inactive")}>
                  <option value="active">Active</option>
                  <option value="inactive">Archived (inactive)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="emp-start">Start date (optional)</label>
                <input id="emp-start" className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="emp-contact">Contact details (optional)</label>
                <input id="emp-contact" className="input" value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="off" placeholder="Phone or email" />
              </div>
              <div className="field">
                <label htmlFor="emp-rate">Salary rate in {business.currency} (optional)</label>
                <input id="emp-rate" className="input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 20000" />
                <p className="field-hint">A rate is the agreed pay — it is never recorded as money paid. Payments are recorded separately below.</p>
              </div>
              <div className="field">
                <label htmlFor="emp-frequency">Salary frequency (optional)</label>
                <select id="emp-frequency" className="input" value={frequency} onChange={(e) => setFrequency(e.target.value as SalaryFrequency | "")}>
                  <option value="">Not set</option>
                  {FREQUENCIES.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </div>
              {employeeError && <p className="alert-error" role="alert">{employeeError}</p>}
              <div className="row-actions">
                <button className="btn" type="submit" disabled={savingEmployee}>
                  {savingEmployee ? "Saving…" : editingId ? "Save changes" : "Add employee"}
                </button>
                <button className="btn ghost" type="button" onClick={() => { resetEmployeeForm(); setShowEmployeeForm(false); }}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          <section className="panel" aria-labelledby="employee-list-heading">
            <div className="panel-head"><h2 id="employee-list-heading">Employees</h2></div>
            {employees.length === 0 ? (
              <p className="muted">No employees yet for {business.name}. Add your first employee to start recording payments.</p>
            ) : (
              <ul className="bucky-insights">
                {employees.map((employee) => {
                  const summary = summaryFor(employee.id);
                  return (
                    <li key={employee.id} className="bucky-insight bucky-info">
                      <strong>
                        {employee.name}
                        {employee.status !== "active" ? " (archived)" : ""}
                      </strong>
                      <p>
                        {employee.role ?? "No position recorded"}
                        {employee.startDate ? ` · started ${formatDate(employee.startDate)}` : ""}
                        {employee.contact ? ` · ${employee.contact}` : ""}
                      </p>
                      {employee.salaryRateMinor ? (
                        <p className="muted">
                          Configured salary rate: {formatMoney(employee.salaryRateMinor, employee.currency ?? business.currency)}
                          {employee.salaryFrequency ? ` / ${FREQUENCIES.find((f) => f.value === employee.salaryFrequency)?.label.toLowerCase()}` : ""}
                          {(summary?.paymentCount ?? 0) > 0
                            ? " — this is the agreed rate, separate from the recorded payments below"
                            : " — this agreed rate is not a recorded payment; no payments recorded yet"}
                        </p>
                      ) : null}
                      <dl className="bucky-evidence">
                        <div><dt>Payments</dt><dd>{summary?.paymentCount ?? 0}</dd></div>
                        {(summary?.totalsByCurrency ?? []).map((t) => (
                          <div key={t.currency}><dt>Total paid ({t.currency})</dt><dd>{formatMoney(t.totalMinor, t.currency)}</dd></div>
                        ))}
                        {summary?.lastPayment && (
                          <div>
                            <dt>Last payment</dt>
                            <dd>{formatMoney(summary.lastPayment.amountMinor, summary.lastPayment.currency)} · {formatDate(summary.lastPayment.date)}</dd>
                          </div>
                        )}
                      </dl>
                      <div className="row-actions">
                        <button className="btn ghost small" type="button" onClick={() => startEdit(employee)}>Edit</button>
                        <button
                          className="btn ghost small"
                          type="button"
                          onClick={() => {
                            setPaymentEmployeeId(employee.id);
                            setHistoryEmployeeId(employee.id);
                            setPendingPayment(null);
                          }}
                        >
                          Record payment
                        </button>
                        <button className="btn ghost small" type="button" onClick={() => setHistoryEmployeeId(employee.id)}>
                          History
                        </button>
                        <button className="btn ghost small" type="button" onClick={() => void onToggleArchive(employee)}>
                          {employee.status === "active" ? "Archive" : "Restore"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {employees.length > 0 && (
            <section className="panel" aria-labelledby="payment-heading">
              <div className="panel-head"><h2 id="payment-heading">Record a payment</h2></div>
              <form onSubmit={onPreviewPayment} noValidate>
                <div className="field">
                  <label htmlFor="pay-employee">Employee</label>
                  <select id="pay-employee" className="input" value={paymentEmployeeId} onChange={(e) => { setPaymentEmployeeId(e.target.value); setPendingPayment(null); }}>
                    <option value="">Choose an employee…</option>
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>{employeeOptionLabel(e, employees)}{e.status !== "active" ? " (archived)" : ""}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pay-type">Payment type</label>
                  <select id="pay-type" className="input" value={paymentType} onChange={(e) => { setPaymentType(e.target.value as CompensationType); setPendingPayment(null); }}>
                    <option value="salary">Salary payment</option>
                    <option value="bonus">Bonus</option>
                    <option value="advance">Advance</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pay-amount">Amount in {business.currency}</label>
                  <input id="pay-amount" className="input" inputMode="decimal" value={paymentAmount} onChange={(e) => { setPaymentAmount(e.target.value); setPendingPayment(null); }} placeholder="e.g. 1000" />
                </div>
                <div className="field">
                  <label htmlFor="pay-date">Date</label>
                  <input id="pay-date" className="input" type="date" value={paymentDate} onChange={(e) => { setPaymentDate(e.target.value); setPendingPayment(null); }} />
                </div>
                <div className="field">
                  <label htmlFor="pay-note">Notes (optional)</label>
                  <input id="pay-note" className="input" value={paymentNote} onChange={(e) => { setPaymentNote(e.target.value); setPendingPayment(null); }} autoComplete="off" placeholder="e.g. November payroll" />
                </div>
                {paymentError && !pendingPayment && <p className="alert-error" role="alert">{paymentError}</p>}
                <div className="row-actions">
                  <button className="btn" type="submit">Preview payment</button>
                </div>
              </form>

              {pendingPayment && (
                <div className="bucky-action-preview" role="region" aria-label="Review this payment before saving">
                  <h3>Review {COMPENSATION_LABELS[paymentType].toLowerCase()} payment</h3>
                  <p className="muted">
                    This saves one business expense linked to the employee. Nothing is saved until you confirm.
                    It is a recorded payment, not a payroll run.
                  </p>
                  <dl className="bucky-evidence">
                    <div><dt>Employee</dt><dd>{(() => { const emp = employees.find((e) => e.id === pendingPayment.relatedId); return emp ? employeeOptionLabel(emp, employees) : ""; })()}</dd></div>
                    <div><dt>Amount</dt><dd>{formatMoney(pendingPayment.amountMinor, pendingPayment.currency)}</dd></div>
                    <div><dt>Date</dt><dd>{pendingPayment.date}</dd></div>
                    <div><dt>Description</dt><dd>{pendingPayment.description}</dd></div>
                    <div><dt>Category</dt><dd>{pendingPayment.category}</dd></div>
                  </dl>
                  {paymentError && <p className="alert-error" role="alert">{paymentError}</p>}
                  <div className="row-actions">
                    <button className="btn" type="button" onClick={() => void onConfirmPayment()} disabled={savingPayment}>
                      {savingPayment ? "Saving…" : "Confirm payment"}
                    </button>
                    <button className="btn ghost" type="button" onClick={() => setPendingPayment(null)} disabled={savingPayment}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {historyEmployee && (
            <section className="panel" aria-labelledby="history-heading">
              <div className="panel-head"><h2 id="history-heading">Payment history — {historyEmployee.name}</h2></div>
              {history.length === 0 ? (
                <p className="muted">No payments recorded for {historyEmployee.name} yet.</p>
              ) : (
                <ul className="bucky-insights">
                  {history.map((t) => (
                    <li key={t.id} className="bucky-insight bucky-info">
                      <strong>{formatMoney(t.amountMinor, t.currency)} · {formatDate(t.date)}</strong>
                      <p>{t.description}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
