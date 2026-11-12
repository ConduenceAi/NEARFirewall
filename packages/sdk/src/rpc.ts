/** Minimal NEAR JSON-RPC client for view calls and account reads. No signing. */

export class RpcError extends Error {
  readonly data: unknown;
  constructor(message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.data = data;
  }
}

export interface AccountState {
  amount: bigint;
  locked: bigint;
  codeHash: string;
  storageUsage: number;
}

/** The code hash NEAR reports for an account without a contract. */
export const EMPTY_CODE_HASH = "11111111111111111111111111111111";

export const NETWORKS = {
  testnet: "https://rpc.testnet.near.org",
  testnetFastnear: "https://test.rpc.fastnear.com",
  mainnet: "https://rpc.mainnet.near.org",
} as const;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** JSON.stringify that writes bigints as decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

export class NearRpc {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(url: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.url = url;
    this.fetchImpl = fetchImpl;
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });
    let response: Response | undefined;
    // Public RPC endpoints rate-limit (429) and occasionally fail (5xx); back off and retry reads.
    for (let attempt = 0; attempt < 5; attempt++) {
      response = await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (response.status !== 429 && response.status < 500) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
    if (!response || !response.ok) throw new RpcError(`RPC HTTP ${response?.status ?? "no response"}`);
    const json = (await response.json()) as { result?: T; error?: { message?: string; data?: unknown; cause?: unknown } };
    if (json.error) {
      throw new RpcError(json.error.message ?? "RPC error", json.error.data ?? json.error.cause);
    }
    const result = json.result as T & { error?: string };
    // Query errors arrive inside `result` for some node versions.
    if (result && typeof result === "object" && "error" in result && typeof result.error === "string") {
      throw new RpcError(result.error);
    }
    return result;
  }

  /** Calls a view method and returns its decoded JSON value (or null for an empty result). */
  async view(contractId: string, methodName: string, args: unknown = {}): Promise<unknown> {
    const result = await this.call<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: toBase64(new TextEncoder().encode(toJson(args))),
    });
    const text = new TextDecoder().decode(Uint8Array.from(result.result));
    return text.length === 0 ? null : JSON.parse(text);
  }

  async viewAccount(accountId: string): Promise<AccountState> {
    const r = await this.call<{ amount: string; locked: string; code_hash: string; storage_usage: number }>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    return { amount: BigInt(r.amount), locked: BigInt(r.locked), codeHash: r.code_hash, storageUsage: r.storage_usage };
  }

  /** Returns true when the account exists. */
  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.viewAccount(accountId);
      return true;
    } catch (error) {
      if (error instanceof RpcError && /does not exist|UNKNOWN_ACCOUNT/i.test(`${error.message} ${JSON.stringify(error.data ?? "")}`)) {
        return false;
      }
      throw error;
    }
  }

  /** Transaction status with receipts, used to resolve submitted operations. */
  async txStatus(txHash: string, senderAccountId: string): Promise<unknown> {
    return this.call("EXPERIMENTAL_tx_status", {
      tx_hash: txHash,
      sender_account_id: senderAccountId,
      wait_until: "FINAL",
    });
  }
}
