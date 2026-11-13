import type { SubmitAgentExecute } from "@nearfirewall/sdk";

/**
 * Runs submissions one after another. A key has a single nonce sequence, so two
 * transactions signed at the same moment with the same key can collide. Callers
 * to the gateway can be concurrent; the key's transactions must not be.
 */
export function serialSubmit(submit: SubmitAgentExecute): SubmitAgentExecute {
  let tail: Promise<unknown> = Promise.resolve();
  return (args, gas) => {
    const run = tail.then(() => submit(args, gas));
    // Keep the chain going whether this submission succeeds or fails.
    tail = run.catch(() => undefined);
    return run;
  };
}
