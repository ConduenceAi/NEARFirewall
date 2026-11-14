/**
 * Builds the signed NEP-366 delegate action an x402 NEAR seller accepts: one
 * `ft_transfer` of exactly `amount` to `payTo` on the token contract, with
 * 1 yoctoNEAR attached. The seller's facilitator relays it and pays the gas.
 *
 * It is signed by the connection key as the full-access key of the payment
 * account (the key's implicit account), never of the owner's account.
 */
import { KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate, type KeyPairString } from "near-api-js";
import { toBase64 } from "./protocol.ts";

/** Gas for the relayed `ft_transfer`. */
export const FT_TRANSFER_GAS = 30n * 10n ** 12n;

export interface FtTransferDelegate {
  secretKey: KeyPairString;
  /** The payment account that holds the token and signs. */
  senderId: string;
  /** The NEP-141 token contract (the seller's `asset`). */
  asset: string;
  payTo: string;
  amount: bigint;
  /** Must be above the access key's current nonce. */
  nonce: bigint;
  /** The last block in which the delegate may be relayed. */
  maxBlockHeight: bigint;
}

/** Signs the delegate and returns it as standard base64 of its Borsh bytes. */
export async function signFtTransferDelegate(input: FtTransferDelegate): Promise<string> {
  const signer = KeyPairSigner.fromSecretKey(input.secretKey);
  const delegateAction = buildDelegateAction({
    senderId: input.senderId,
    receiverId: input.asset,
    actions: [
      actions.functionCall("ft_transfer", { receiver_id: input.payTo, amount: input.amount.toString() }, FT_TRANSFER_GAS, 1n),
    ],
    nonce: input.nonce,
    maxBlockHeight: input.maxBlockHeight,
    publicKey: await signer.getPublicKey(),
  });
  const { signedDelegate } = await signer.signDelegateAction(delegateAction);
  return toBase64(encodeSignedDelegate(signedDelegate));
}
