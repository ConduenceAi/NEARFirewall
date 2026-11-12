# NEARFirewall

NEARFirewall is a proposed NEAR-native protocol for programmable identity and financial access. It uses an ENS-inspired registry to resolve human-readable names, then lets identity owners grant wallets, applications, and agents limited authority to act on their behalf. Smart contracts enforce the rules for spending from a vault associated with the identity.

**Status:** Design stage. The contracts and testnet demo below are planned.

## Core components

| Component | Responsibility |
| --- | --- |
| **Identity Registry** | Register a name such as `alice.protocol.near`, mint an identity NFT, and resolve the name to a NEAR account. An identity record includes its ID, owner, controller, metadata, and associated vault. Names are registry entries and can resolve to existing NEAR accounts. |
| **Permission Manager** | Let the identity owner grant and revoke access for a specific NEAR account. A grant specifies the allowed action, asset, recipient, spending limits, and expiry. Broader roles can cover record management, approved contract calls, and constrained delegation. |
| **Financial Controller** | Hold deposited funds in a contract-controlled vault. Validate the caller, active grant, requested action, balance, and available spending limit on-chain before submitting a transfer. |

The identity NFT represents ownership. The registry and permission rules determine who can manage the identity and spend from its vault. NEAR function-call keys can restrict the contract and methods a key can call. The Financial Controller enforces asset, recipient, and spending restrictions. [NEAR access keys](https://docs.near.org/protocol/accounts-contracts/access-keys)

## Proposed vault model

The MVP design links the identity to the owner's existing NEAR account for resolution and uses a dedicated, contract-controlled vault for authorized spending. The owner deposits the funds they want covered by the policy. The agent signs with its own account and can request only the actions allowed by its grant. This gives the demo an on-chain enforcement point for every delegated spend.

The spending check must account for transfers that are still pending. The controller reserves the amount against the available balance and daily limit before submitting the transfer, then settles or releases the reservation when it receives the result. Revocation takes effect for new authorizations. [NEAR cross-contract calls](https://docs.near.org/smart-contracts/anatomy/crosscontract)

## Hackathon MVP

- Register an identity, mint its NEP-171 NFT, and resolve the name to a NEAR account.
- Associate a vault with the identity and fund it with testnet NEAR.
- Grant and revoke a transfer permission for an agent account.
- Enforce per-transfer and daily spending limits, a recipient allowlist, and an expiry on-chain.
- Demonstrate an allowed transfer, an over-budget rejection, and a rejection after revocation.

Sub-identities, delegated grants, dynamic metadata, fungible-token spending, and approved application calls are follow-up features.

### Demo flow

1. Alice registers `alice.protocol.near`, receives its identity NFT, and deposits 100 testnet NEAR into the associated vault.
2. Alice grants her agent permission to transfer up to 5 NEAR per transaction and 10 NEAR per day to an approved recipient for seven days.
3. The agent submits a 2 NEAR transfer to the approved recipient. The transfer settles and leaves 8 NEAR in the daily budget.
4. Two more 3 NEAR transfers settle. Another 3 NEAR request is rejected because only 2 NEAR remains in the daily budget.
5. Alice revokes the grant. A new 2 NEAR request is rejected even though the daily budget can cover it.

## NEAR standards

- Identity NFT ownership follows [NEP-171](https://github.com/near/NEPs/blob/master/neps/nep-0171.md).
- NFT metadata can use [NEP-177](https://github.com/near/NEPs/blob/master/neps/nep-0177.md).
- Optional NFT transfer approvals and royalties are covered by [NEP-178](https://github.com/near/NEPs/blob/master/neps/nep-0178.md) and [NEP-199](https://github.com/near/NEPs/blob/master/neps/nep-0199.md).

## Repository

```bash
git clone https://github.com/ConduenceAi/NEARFirewall.git
cd NEARFirewall
```
