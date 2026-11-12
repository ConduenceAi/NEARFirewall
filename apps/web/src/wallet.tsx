/**
 * Wallet connection through NEAR Connect (Meteor and other NEAR wallets).
 *
 * Every owner write built by the SDK attaches 1 yoctoNEAR, so the wallet always
 * asks the owner to confirm it. This app never adds a function-call key to the
 * owner's account.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NearConnector } from "@fastnear/near-connect";
import { fromBase64, type WalletTransaction } from "@nearfirewall/sdk";
import { config } from "./config.ts";

const connector = new NearConnector({ network: config.network });

export interface SendResult {
  txHash?: string;
  /** Decoded JSON return value, if any. */
  value?: unknown;
  failure?: string;
}

interface WalletState {
  accountId: string | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(tx: WalletTransaction): Promise<SendResult>;
}

const WalletContext = createContext<WalletState | null>(null);

function decodeOutcome(outcome: unknown): SendResult {
  const o = outcome as { transaction?: { hash?: string }; status?: Record<string, unknown> } | undefined;
  const txHash = o?.transaction?.hash;
  const status = o?.status;
  if (status && typeof status.SuccessValue === "string") {
    const text = new TextDecoder().decode(fromBase64(status.SuccessValue));
    let value: unknown = text;
    try {
      value = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON; keep the text.
    }
    return { txHash, value };
  }
  if (status && "Failure" in status) return { txHash, failure: JSON.stringify(status.Failure) };
  return { txHash };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    connector.on("wallet:signIn", (event) => setAccountId(event.accounts[0]?.accountId ?? null));
    connector.on("wallet:signOut", () => setAccountId(null));
    connector
      .wallet()
      .then((wallet) => wallet.getAccounts())
      .then((accounts) => setAccountId(accounts[0]?.accountId ?? null))
      .catch(() => setAccountId(null));
  }, []);

  const connect = useCallback(async () => {
    await connector.connect();
  }, []);

  const disconnect = useCallback(async () => {
    await connector.disconnect();
    setAccountId(null);
  }, []);

  const send = useCallback(async (tx: WalletTransaction) => {
    const wallet = await connector.wallet();
    const outcome = await wallet.signAndSendTransaction({
      network: config.network,
      receiverId: tx.receiverId,
      actions: tx.actions,
    });
    return decodeOutcome(outcome);
  }, []);

  const value = useMemo(() => ({ accountId, connect, disconnect, send }), [accountId, connect, disconnect, send]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const state = useContext(WalletContext);
  if (!state) throw new Error("useWallet must be used inside WalletProvider");
  return state;
}
