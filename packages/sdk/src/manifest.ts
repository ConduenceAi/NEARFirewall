import { z } from "zod";

/** The deployment manifest in `deployments/<network>.json`. */
export const DeploymentManifest = z.object({
  network: z.enum(["testnet", "mainnet", "sandbox"]),
  rpcUrl: z.string().url(),
  registry: z.string(),
  policy: z.object({
    /** Base58 code hash of the account policy WASM, as `view_account` reports it. */
    codeHash: z.string(),
    /** Set when the policy is published as a global contract. */
    globalCodeHash: z.string().nullable().optional(),
    /** Path or URL of the WASM, for direct deployment. */
    wasm: z.string().nullable().optional(),
  }),
  registryCodeHash: z.string(),
  abiVersion: z.string(),
  sourceRevision: z.string(),
});
export type DeploymentManifest = z.infer<typeof DeploymentManifest>;
