/**
 * Installs contract code with a one-time setup key, for wallets that refuse to
 * sign a contract deployment (Meteor blocks DeployContract):
 *
 *   1. The wallet signs one transaction that adds a full-access key generated
 *      here (for the registry, the same transaction creates `agents.<you>`).
 *   2. This page signs, with that key, one transaction that deploys the code,
 *      initializes it, and deletes the key. Either all of it happens or none.
 *
 * The key never leaves this page's memory and lives only between the two
 * transactions. If step 2 fails, the page deletes the key with the key itself.
 */
import type { WalletAction, WalletTransaction } from "@nearfirewall/sdk";
import { config } from "./config.ts";
import type { SendResult } from "./wallet.tsx";

export interface SetupKeyPlan {
  /** The account the code goes on: your account (policy) or `agents.<you>` (registry). */
  accountId: string;
  /** Step 1, signed by the wallet. */
  grant(setupPublicKey: string): WalletTransaction;
  /** Step 2, signed by the setup key. Must end by deleting the key. */
  install(setupPublicKey: string): WalletTransaction;
}

/** Wallet errors that mean "this wallet will not deploy contracts". */
export function isDeployBlocked(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /deploy|DeployContract|blocked|not supported|unsupported action/i.test(text);
}

export async function installWithSetupKey(
  walletSend: (tx: WalletTransaction) => Promise<SendResult>,
  plan: SetupKeyPlan,
  onStep: (text: string) => void = () => {},
): Promise<{ txHash: string }> {
  const { Account, KeyPair, PublicKey, actions } = await import("near-api-js");
  const pair = KeyPair.fromRandom("ed25519");
  const publicKey = pair.getPublicKey().toString();

  onStep("Approve the one-time setup key in your wallet…");
  const granted = await walletSend(plan.grant(publicKey));
  if (granted.failure) throw new Error(`The wallet transaction failed: ${granted.failure}`);

  const account = new Account(plan.accountId, config.rpcUrl, pair.toString());
  const toActions = (list: WalletAction[]) =>
    list.map((a) => {
      switch (a.type) {
        case "DeployContract":
          return actions.deployContract(a.params.code);
        case "FunctionCall":
          return actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit));
        case "DeleteKey":
          return actions.deleteKey(PublicKey.fromString(a.params.publicKey));
        default:
          throw new Error(`A setup key does not sign ${a.type} actions.`);
      }
    });
  const submit = async (list: WalletAction[]) => {
    // The new key can take a few seconds to show on the RPC node.
    for (let attempt = 0; ; attempt++) {
      try {
        return await account.signAndSendTransaction({ receiverId: plan.accountId, actions: toActions(list), waitUntil: "FINAL", throwOnFailure: false });
      } catch (error) {
        if (attempt >= 8 || !/access key|does not exist|AccessKeyDoesNotExist|InvalidNonce/i.test(String(error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  };

  onStep("Installing the contract with the setup key…");
  try {
    const response = await submit(plan.install(publicKey).actions);
    const status = response.status as { Failure?: unknown };
    if (status && typeof status === "object" && "Failure" in status) {
      throw new Error(`The install transaction failed: ${JSON.stringify(status.Failure).slice(0, 300)}`);
    }
    return { txHash: response.transaction.hash };
  } catch (error) {
    // The install is atomic, so on failure the key is still there: remove it now.
    onStep("The install failed. Removing the setup key…");
    await submit([{ type: "DeleteKey", params: { publicKey } }]).catch(() => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} The setup key ${publicKey} could not be removed; delete it from your wallet.`,
      );
    });
    throw error;
  }
}

/** Downloads contract code served next to the app. */
export async function loadCode(url: string, what: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`${what} WASM is unavailable. Run the contract build and copy the WASM into apps/web/public.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
