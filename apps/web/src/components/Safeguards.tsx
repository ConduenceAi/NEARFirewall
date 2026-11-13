import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { addGuardianKey, blockRecipient, removeGuardianKey, unblockRecipient, type PolicyClient, type WalletTransaction } from "@nearfirewall/sdk";
import { generateAgentKey } from "../agent-key.ts";
import { rpc } from "../config.ts";
import { timeText } from "../format.ts";
import { useAsync } from "../hooks.ts";

type Exec = (label: string, tx: WalletTransaction | (() => WalletTransaction | Promise<WalletTransaction>), handle?: (value: unknown) => void) => Promise<boolean>;

const ACCOUNT = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

/**
 * Blocked recipients and guardians. A blocked recipient is refused for every
 * agent, whatever the approvals say. A guardian is a watcher key that can add to
 * the blocklist and do nothing else.
 */
export function Safeguards({ policy, busy, exec }: { policy: PolicyClient; busy: boolean; exec: Exec }) {
  const payer = policy.payerId;
  const blocked = useAsync(() => policy.getBlocklist(), [payer, busy]);
  const guardians = useAsync(() => policy.getGuardians(), [payer, busy]);
  const [recipient, setRecipient] = useState("");
  const [reason, setReason] = useState("");
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<{ label: string; publicKey: string; secretKey: string } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function block() {
    const target = recipient.trim();
    if (!ACCOUNT.test(target)) return setError("Enter a NEAR account ID, such as scam.testnet.");
    setError(null);
    if (await exec("Block recipient", blockRecipient(payer, target, reason.trim() || undefined))) {
      setRecipient("");
      setReason("");
    }
  }

  async function addGuardian() {
    const name = label.trim();
    if (!name || new TextEncoder().encode(name).length > 48) return setError("Enter a label of up to 48 bytes.");
    setError(null);
    try {
      const pair = await generateAgentKey();
      // Show the key only after the wallet transaction succeeds.
      if (await exec("Add guardian", addGuardianKey(payer, { publicKey: pair.publicKey, label: name }))) {
        setCreated({ label: name, ...pair });
        setRevealed(false);
        setLabel("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="card safeguards-card" aria-labelledby="safeguards-title">
      <div className="row">
        <ShieldAlert size={18} aria-hidden="true" />
        <h3 id="safeguards-title">Blocked recipients</h3>
      </div>
      <p className="hint">
        Nobody on this list can be paid by any of your agents, even where an approval exists. It applies from the next request.
      </p>
      {blocked.error && <p className="notice error">{blocked.error}</p>}
      {blocked.data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Added by</th>
              <th>Reason</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {blocked.data.map((b) => (
              <tr key={b.recipient}>
                <td>{b.recipient}</td>
                <td>{b.by === "owner" ? "You" : b.by.replace("guardian:", "Guardian ")}</td>
                <td>{b.reason ?? "—"}</td>
                <td>{timeText(b.at)}</td>
                <td>
                  <button disabled={busy} onClick={() => void exec("Unblock recipient", unblockRecipient(payer, b.recipient))}>
                    Unblock
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{blocked.loading ? "Loading…" : "No recipients are blocked."}</p>
      )}
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void block();
        }}
      >
        <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="recipient.testnet" aria-label="Recipient to block" required />
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" maxLength={120} aria-label="Reason" />
        <button type="submit" className="danger" disabled={busy}>
          Block recipient
        </button>
      </form>

      <h3>Guardians</h3>
      <p className="hint">
        A guardian is a watcher key that can only add recipients to this list, for example when a vendor's site is hijacked. It cannot
        unblock, approve, raise a limit, or pay, and it can add at most 50 entries. Guardian entries are marked, and you can remove them.
      </p>
      {guardians.error && <p className="notice error">{guardians.error}</p>}
      {guardians.data?.map((g) => (
        <div className="row" key={g.public_key}>
          <strong>{g.label}</strong>
          <span className="badge">{g.public_key.slice(0, 16)}…</span>
          <span className="hint">
            {g.blocks} block{g.blocks === 1 ? "" : "s"} · {g.last_used ? `last used ${timeText(g.last_used)}` : "never used"}
          </span>
          <button
            disabled={busy}
            onClick={() =>
              void exec("Remove guardian", async () => {
                const keys = await rpc.viewAccessKeys(payer);
                return removeGuardianKey(payer, g.public_key, { keyPresent: keys.some((k) => k.publicKey === g.public_key) });
              })
            }
          >
            Remove
          </button>
        </div>
      ))}
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void addGuardian();
        }}
      >
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Guardian label, such as site watcher" maxLength={48} aria-label="Guardian label" required />
        <button type="submit" disabled={busy}>
          Add guardian key
        </button>
      </form>
      {error && <p className="notice error">{error}</p>}
      {created && (
        <div className="notice ok" role="status">
          <p>
            <strong>Guardian key ready: {created.label}.</strong> It can only call <code>guardian_block</code> on {payer}. Save it in the
            watcher's secret settings now; it is not shown again.
          </p>
          {revealed && <textarea readOnly aria-label="Guardian private key" value={created.secretKey} rows={3} spellCheck={false} />}
          <div className="actions">
            <button type="button" onClick={() => setRevealed(!revealed)}>
              {revealed ? "Hide key" : "Reveal key"}
            </button>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(created.secretKey)}>
              Copy key
            </button>
            <button type="button" onClick={() => setCreated(null)}>
              I've saved it
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
