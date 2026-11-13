/**
 * Wallet connection through NEAR Connect (Meteor and other NEAR wallets).
 *
 * Every owner write built by the SDK attaches 1 yoctoNEAR, so the wallet always
 * asks the owner to confirm it. This app never adds a function-call key to the
 * owner's account.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  connecting: boolean;
  connect(): Promise<boolean>;
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
  const [connecting, setConnecting] = useState(false);
  const connectingRef = useRef(false);

  useEffect(() => {
    let restore = true;
    const signIn = (event: { accounts: { accountId: string }[] }) => {
      restore = false;
      setAccountId(event.accounts[0]?.accountId ?? null);
    };
    const signOut = () => {
      restore = false;
      setAccountId(null);
    };
    connector.on("wallet:signIn", signIn);
    connector.on("wallet:signOut", signOut);
    connector
      .wallet()
      .then((wallet) => wallet.getAccounts())
      .then((accounts) => { if (restore) setAccountId(accounts[0]?.accountId ?? null); })
      .catch(() => { if (restore) setAccountId(null); });
    return () => {
      restore = false;
      connector.off("wallet:signIn", signIn);
      connector.off("wallet:signOut", signOut);
    };
  }, []);

  const connect = useCallback(async () => {
    if (connectingRef.current) return false;
    connectingRef.current = true;
    setConnecting(true);
    try {
      await connector.connect();
      return true;
    } catch (error) {
      if (error instanceof Error && ["User rejected", "Wallet closed"].includes(error.message)) return false;
      throw error;
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
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

  const value = useMemo(() => ({ accountId, connecting, connect, disconnect, send }), [accountId, connecting, connect, disconnect, send]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const state = useContext(WalletContext);
  if (!state) throw new Error("useWallet must be used inside WalletProvider");
  return state;
}
