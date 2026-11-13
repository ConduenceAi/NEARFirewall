/**
 * Signs the SDK's wallet transactions with a key from the NEAR CLI legacy
 * keychain (~/.near-credentials/<network>/<account>.json), for scripts that
 * play the owner without a browser wallet. Keys are never printed.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, PublicKey, actions, type KeyPairString } from "near-api-js";
import type { WalletAction, WalletTransaction } from "@nearfirewall/sdk";

export function keychainPath(network: string, account: string) {
  return join(homedir(), ".near-credentials", network, `${account}.json`);
}

export async function ownerAccount(account: string, rpcUrl: string, network = "testnet"): Promise<Account> {
  const { private_key } = JSON.parse(await readFile(keychainPath(network, account), "utf8")) as { private_key: string };
  return new Account(account, rpcUrl, private_key as KeyPairString);
}

export function toNearActions(walletActions: WalletAction[]) {
  return walletActions.map((a) => {
    switch (a.type) {
      case "CreateAccount":
        return actions.createAccount();
      case "Transfer":
        return actions.transfer(BigInt(a.params.deposit));
      case "DeployContract":
        return actions.deployContract(a.params.code);
      case "UseGlobalContract":
        return actions.useGlobalContract({ codeHash: a.params.contractIdentifier.codeHash });
      case "FunctionCall":
        return actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit));
      case "AddKey": {
        const p = a.params.accessKey.permission;
        return actions.addFunctionCallAccessKey(PublicKey.fromString(a.params.publicKey), p.receiverId, p.methodNames, BigInt(p.allowance));
      }
      case "DeleteKey":
        return actions.deleteKey(PublicKey.fromString(a.params.publicKey));
    }
  });
}

/** Signs and sends one wallet transaction; returns the hash and the decoded final value. */
export async function send(account: Account, tx: WalletTransaction) {
  const response = await account.signAndSendTransaction({
    receiverId: tx.receiverId,
    actions: toNearActions(tx.actions),
    waitUntil: "FINAL",
  });
  const status = response.status as { SuccessValue?: string; Failure?: unknown };
  let value: unknown;
  if (typeof status.SuccessValue === "string" && status.SuccessValue.length > 0) {
    const text = Buffer.from(status.SuccessValue, "base64").toString("utf8");
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return { hash: response.transaction.hash, value, failure: status.Failure };
}
