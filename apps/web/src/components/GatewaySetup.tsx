import { useMemo, useState } from "react";
import { config } from "../config.ts";
import type { AgentPlatform } from "../platforms.ts";

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Setup for cloud platforms. They cannot start a program on your computer, so
 * they reach the agent through a gateway you host: one small service that holds
 * this connection key and is protected by a token generated here, in the browser.
 * NEARFirewall never sees either secret.
 */
export function GatewaySetup({ accountId, secretKey, platform, onDone }: { accountId: string; secretKey: string; platform: AgentPlatform; onDone(): void }) {
  const recipe = platform.gateway!;
  const token = useMemo(newToken, []);
  const [address, setAddress] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);

  const base = address.trim().replace(/\/+$/, "");
  const https = /^https:\/\/[^\s/]+/.test(base);
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base);
  const usable = https || local;
  const mcpUrl = usable ? `${base}/mcp/${token}` : "";

  const env = [
    `NEARFIREWALL_ACCOUNT=${accountId}`,
    `NEARFIREWALL_NETWORK=${config.network}`,
    `NEARFIREWALL_AGENT_KEY=${secretKey}`,
    `GATEWAY_TOKEN=${token}`,
    `GATEWAY_ALLOWED_ORIGINS=${window.location.origin}`,
  ].join("\n");

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${label} copied.`);
    } catch {
      setMessage("Clipboard unavailable. Reveal the value and copy it manually.");
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([env + "\n"], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "nearfirewall-gateway.env";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function check() {
    setChecking(true);
    setMessage("");
    try {
      const response = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } });
      const body = (await response.json()) as { ok?: boolean; agent?: string; error?: string };
      setMessage(response.ok && body.ok ? `Gateway OK. It is connected as agent ${body.agent ?? ""}.` : `The gateway answered: ${body.error ?? response.status}.`);
    } catch {
      setMessage("Could not reach the gateway. Check the address, that it is running, and that GATEWAY_ALLOWED_ORIGINS includes this site.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="connection-setup">
      <h3>Restricted key ready: set up your gateway</h3>
      <p>
        {platform.name} runs in the cloud, so it connects through a small gateway that you host. The gateway holds this key and is protected
        by a token made in your browser just now. Put both in your host's secret settings, never in a repository or a chat.
      </p>

      <h3>1. Start the gateway</h3>
      <p className="hint">Save these settings in a file or your host's secrets. They are not shown again after you close this panel.</p>
      {revealed && <textarea readOnly aria-label="Gateway settings" value={env} rows={6} spellCheck={false} />}
      <div className="actions">
        <button type="button" onClick={() => setRevealed(!revealed)}>{revealed ? "Hide settings" : "Reveal settings"}</button>
        <button type="button" onClick={() => void copy(env, "Settings")}>Copy settings</button>
        <button type="button" onClick={download}>Download .env</button>
      </div>
      <p>From the NEARFirewall folder, with Docker:</p>
      <pre><code>{`docker build -f apps/gateway/Dockerfile -t nearfirewall-gateway .
docker run -d --restart unless-stopped -p 8787:8787 --env-file nearfirewall-gateway.env nearfirewall-gateway`}</code></pre>
      <p className="hint">Or without Docker (Node.js 24): set the same settings in the environment and run <code>node apps/gateway/src/main.ts</code>.</p>

      <h3>2. Serve it over HTTPS</h3>
      <p>The token travels with every request, so put the gateway behind HTTPS (your host's TLS, a reverse proxy, or a tunnel) and enter its public address here.</p>
      <label>
        Gateway address
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://nearfirewall.example.com" inputMode="url" spellCheck={false} />
      </label>
      {address && !usable && <p className="notice error">Use an https:// address (http://localhost is allowed for testing).</p>}
      {usable && (
        <div className="actions">
          <button type="button" disabled={checking} onClick={() => void check()}>{checking ? "Checking…" : "Check gateway"}</button>
        </div>
      )}

      <h3>3. Connect {platform.name}</h3>
      {usable ? (
        <>
          {recipe.kind === "mcp" ? (
            <>
              <p>MCP server URL (the secret is part of it):</p>
              <pre><code>{revealed ? mcpUrl : `${base}/mcp/${"•".repeat(12)}`}</code></pre>
              <button type="button" onClick={() => void copy(mcpUrl, "MCP server URL")}>Copy MCP server URL</button>
            </>
          ) : (
            <>
              <p>REST API: send the token as <code>Authorization: Bearer &lt;token&gt;</code>.</p>
              <pre><code>{`GET  ${base}/api/rules\nPOST ${base}/api/pay      {"recipient":"vendor.testnet","amount_near":"2"}`}</code></pre>
              <button type="button" onClick={() => void copy(token, "Token")}>Copy token</button>
            </>
          )}
        </>
      ) : (
        <p className="hint">Enter your gateway's address above to get the connection details.</p>
      )}
      <ol>
        {recipe.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p role="status">{message}</p>
      <button className="primary" type="button" onClick={onDone}>I've saved it</button>
    </section>
  );
}
