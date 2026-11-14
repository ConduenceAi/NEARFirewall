import { useState, type FormEvent } from "react";
import { ArrowRight, Code2, KeyRound, RotateCcw, Users } from "lucide-react";
import { href } from "../router.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 5, 1);
const dateLabel = new Intl.DateTimeFormat("en", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const ROLES = {
  Contractor: { amount: 40, cadence: "weekly" },
  Engineer: { amount: 180, cadence: "monthly" },
} as const;

type Department = "engineering" | "hr";
type Cadence = "weekly" | "monthly";
type Role = keyof typeof ROLES;
type Payee = {
  id: number;
  department: Department;
  name: string;
  amount: number;
  cadence: Cadence;
  nextDue: number;
  status: "approved" | "pending" | "declined";
  role?: Role;
};
type Payment = { payee: Payee; due: number };

const INITIAL_PAYEES: Payee[] = [
  { id: 1, department: "engineering", name: "Newsliquid", amount: 8, cadence: "monthly", nextDue: START, status: "approved" },
  { id: 2, department: "engineering", name: "Predixon", amount: 12, cadence: "monthly", nextDue: START, status: "approved" },
  { id: 3, department: "hr", name: "Maya Rao", role: "Contractor", ...ROLES.Contractor, nextDue: START, status: "approved" },
  { id: 4, department: "hr", name: "Alex Chen", role: "Engineer", ...ROLES.Engineer, nextDue: START, status: "approved" },
];

function nextOccurrence(date: number, cadence: Cadence) {
  if (cadence === "weekly") return date + 7 * DAY;
  const current = new Date(date);
  return Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1);
}

export function PaymentDemo() {
  const [department, setDepartment] = useState<Department>("engineering");
  const [date, setDate] = useState(START);
  const [payees, setPayees] = useState(INITIAL_PAYEES);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("Contractor");
  const [message, setMessage] = useState("");
  const isHR = department === "hr";
  const agent = department + ".company.near";
  const visible = payees.filter((payee) => payee.department === department);
  const due = visible.some((payee) => payee.status === "approved" && payee.nextDue <= date);
  const activity = payments.filter((payment) => payment.payee.department === department);

  function requestApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const recipient = name.trim();
    if (!recipient) return;
    if (visible.some((payee) => payee.status !== "declined" && payee.name.toLowerCase() === recipient.toLowerCase())) {
      setMessage(recipient + " already has a rule or a pending request.");
      return;
    }
    const rule = isHR ? ROLES[role] : { amount: 10, cadence: "monthly" as const };
    setPayees([...payees, {
      id: payees.length + 1, department, name: recipient, ...rule, role: isHR ? role : undefined,
      nextDue: date, status: "pending",
    }]);
    setName("");
    setMessage("Owner approval requested for " + recipient + ".");
  }

  function review(payee: Payee, approve: boolean) {
    const cadence = payee.cadence;
    const today = new Date(date);
    const nextDue = cadence === "weekly" ? date + 7 * DAY : Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
    setPayees(payees.map((item) => item.id === payee.id ? { ...item, nextDue, status: approve ? "approved" : "declined" } : item));
    setMessage(approve ? payee.name + " approved. First payment is due " + dateLabel.format(nextDue) + "." : "The owner declined " + payee.name + ".");
  }

  function runPayments() {
    const settled: Payment[] = [];
    const updated = payees.map((payee) => {
      if (payee.department !== department || payee.status !== "approved" || payee.nextDue > date) return payee;
      let nextDue = payee.nextDue;
      while (nextDue <= date) {
        settled.push({ payee, due: nextDue });
        nextDue = nextOccurrence(nextDue, payee.cadence);
      }
      return { ...payee, nextDue };
    });
    if (settled.length === 0) return;
    setPayees(updated);
    setPayments([...payments, ...settled.sort((a, b) => a.due - b.due)]);
    setMessage(settled.length + (settled.length === 1 ? " payment settled" : " payments settled") + " under approved rules.");
  }

  function selectDepartment(next: Department) {
    setDepartment(next);
    setName("");
    setMessage("");
  }

  function reset() {
    selectDepartment("engineering");
    setDate(START);
    setPayees(INITIAL_PAYEES);
    setPayments([]);
    setRole("Contractor");
  }

  return (
    <section className="landing-section walkthrough company-demo" id="payment-walkthrough" aria-labelledby="walkthrough-title">
      <div className="walkthrough-copy">
        <h2 id="walkthrough-title">Try it</h2>
        <p className="lead">Run approved payments, request an exception, then advance the company calendar to see what comes due.</p>
        <div className="payment-scenarios" role="group" aria-label="Department">
          <button type="button" aria-pressed={!isHR} onClick={() => selectDepartment("engineering")}>
            <span className="scenario-icon" data-tone="engineering"><Code2 size={18} aria-hidden="true" /></span>
            <span><strong>Engineering</strong><small>Renew subscriptions and request a new vendor.</small></span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <button type="button" aria-pressed={isHR} onClick={() => selectDepartment("hr")}>
            <span className="scenario-icon" data-tone="hr"><Users size={18} aria-hidden="true" /></span>
            <span><strong>HR</strong><small>Run payroll and request approval for a new hire.</small></span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
        <a className="text-link demo-setup-link" href={href("/docs/connect-agent")}>Connect a real agent <ArrowRight size={15} aria-hidden="true" /></a>
      </div>

      <div className="walkthrough-panel">
        <header className="demo-panel-header">
          <span className="demo-agent-icon"><KeyRound size={19} aria-hidden="true" /></span>
          <div><h3>{isHR ? "Payroll" : "Subscriptions"}</h3><p><code>{agent}</code></p></div>
          <span className="demo-mode">Simulation</span>
          <button className="icon-btn" type="button" aria-label="Restart demo" title="Restart demo" onClick={reset}><RotateCcw size={16} aria-hidden="true" /></button>
        </header>

        <div className="demo-wallet-strip">
          <strong>{dateLabel.format(date)}</strong>
          <button type="button" onClick={() => { setDate(date + 7 * DAY); setMessage(""); }}>Advance one week</button>
        </div>

        <div className="company-demo-body">
          <ul className="company-payee-list" aria-label={isHR ? "Payroll rules" : "Subscription rules"}>
            {visible.map((payee) => (
              <li key={payee.id}>
                <div><strong>{payee.name}</strong><small>{payee.role ? payee.role + " · " : ""}{payee.amount} NEAR {payee.cadence}</small></div>
                <div className="payee-state" data-state={payee.status}>
                  {payee.status === "approved" ? (payee.nextDue <= date ? "Due now" : "Next " + dateLabel.format(payee.nextDue))
                    : payee.status === "pending" ? "Needs owner approval" : "Declined"}
                </div>
                {payee.status === "pending" && (
                  <div className="demo-approval" role="group" aria-label={"Owner review for " + payee.name}>
                    <button type="button" onClick={() => review(payee, false)}>Decline</button>
                    <button type="button" className="primary" onClick={() => review(payee, true)}>Approve rule</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="primary" disabled={!due} onClick={runPayments}>{isHR ? "Run due payroll" : "Pay due subscriptions"}</button>

          <form className="company-demo-form" onSubmit={requestApproval}>
            <h4>{isHR ? "Add a new employee" : "Add a subscription vendor"}</h4>
            <label>{isHR ? "Employee name" : "Vendor name"}<input required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></label>
            {isHR ? <label>Role and pay schedule<select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {Object.entries(ROLES).map(([key, rule]) => <option key={key} value={key}>{key} · {rule.amount} NEAR {rule.cadence}</option>)}
            </select></label> : <small>Sample subscription rule · 10 NEAR monthly</small>}
            <button type="submit">Request owner approval</button>
          </form>

          <p className="company-demo-message" role="status">{message}</p>
          <div className="company-demo-log">
            <h4>Payment activity</h4>
            {activity.length === 0 ? <p>Run a due payment to see its record here.</p> : <ol aria-label="Simulated payment records">
              {activity.toReversed().map(({ payee, due: paymentDate }) => (
                <li key={payee.id + "-" + paymentDate}><span>{agent} → <strong>{payee.name}</strong></span><small>{payee.amount} NEAR · Due {dateLabel.format(paymentDate)} · Settled</small></li>
              ))}
            </ol>}
          </div>
        </div>
        <footer className="demo-footer">Sample schedules and amounts · No wallet or real funds required</footer>
      </div>
    </section>
  );
}
