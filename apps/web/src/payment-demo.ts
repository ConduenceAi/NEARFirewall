import { parseNear } from "@nearfirewall/sdk";
import { near } from "./format.ts";

export const RECIPIENT_DAILY_CAP = parseNear("6");
export const RECIPIENT_PAYMENT_CAP = parseNear("3");
export const AGENT_PAYMENT_CAP = parseNear("5");
export const CONFIRM_ABOVE = parseNear("2");
export const INITIAL_SPEND = parseNear("1");

const RECIPIENTS = { noa: "Noa Market", dragons: "Dragons Market" } as const;
type Recipient = keyof typeof RECIPIENTS;
type Status = "settled" | "blocked" | "pending" | "declined";

export type PaymentRequest = { recipient: Recipient; amount: bigint };
export type DemoPayment = PaymentRequest & {
  id: number;
  prompt: string;
  status: Status;
  detail: string;
  previewBlocked: boolean;
};

export function recipientName(recipient: Recipient) {
  return RECIPIENTS[recipient];
}

export function parseDemoRequest(message: string, approved: string = RECIPIENTS.noa, unapproved: string = RECIPIENTS.dragons): PaymentRequest | null {
  if (!/^(?:please\s+)?(?:pay|send)\b/i.test(message.trim())) return null;
  const amounts = [...message.matchAll(/(?<![\w.,+-])(\d+(?:\.\d{1,5})?)\s*NEAR\b/gi)];
  const words = message.toLowerCase().match(/[a-z]+/g) ?? [];
  const mentions = (name: string) => (" " + words.join(" ") + " ").includes(" " + name.toLowerCase() + " ");
  const noa = mentions(approved);
  const dragons = mentions(unapproved);
  if (amounts.length !== 1 || noa === dragons) return null;
  const amount = parseNear(amounts[0]![1]!);
  return amount > 0n ? { recipient: noa ? "noa" : "dragons", amount } : null;
}

export function evaluateDemoPayment(request: PaymentRequest, spent: bigint, reserved: bigint, approved: string = RECIPIENTS.noa, unapproved: string = RECIPIENTS.dragons): Pick<DemoPayment, "status" | "detail" | "previewBlocked"> {
  const { amount, recipient } = request;
  if (amount > AGENT_PAYMENT_CAP) {
    return { status: "blocked", detail: `The registry blocked this request because it exceeds the agent’s ${near(AGENT_PAYMENT_CAP)} ceiling.`, previewBlocked: false };
  }
  if (recipient !== "noa") {
    return { status: "blocked", detail: unapproved + " is outside your approved recipient list. I stopped at the policy check.", previewBlocked: true };
  }
  if (amount > RECIPIENT_PAYMENT_CAP) {
    return { status: "blocked", detail: `${approved} allows up to ${near(RECIPIENT_PAYMENT_CAP)} per payment. I stopped at the policy check.`, previewBlocked: true };
  }
  const available = RECIPIENT_DAILY_CAP - spent - reserved;
  if (amount > available) {
    return { status: "blocked", detail: `${approved} has ${near(available)} left in today’s budget. I stopped at the policy check.`, previewBlocked: true };
  }
  if (amount > CONFIRM_ABOVE) {
    return { status: "pending", detail: `This fits your limits. I reserved ${near(amount)} and sent the request to your approval queue.`, previewBlocked: false };
  }
  return { status: "settled", detail: `I paid ${near(amount)} to ${approved} and recorded the result in Activity.`, previewBlocked: false };
}
