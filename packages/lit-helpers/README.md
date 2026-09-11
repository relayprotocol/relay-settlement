# Lit Helpers

Shared Lit/Chipotle account and provisioning utilities used by
[`lit-allocator`](../lit-allocator) and
[`lit-deposit-address`](../lit-deposit-address).

This package owns action-agnostic operations: account authentication, PKP
creation, group and permission setup, usage API keys, ownership, billing, and
MPC/multisig calldata generation. The action packages own their action code,
environment configuration, and resource names.

## Core concepts

| Resource        | Purpose                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Account API key | Identifies a Lit account and authorizes account-level API and billing operations. Pass it as `--account-api-key`. |
| PKP             | The Lit-managed signing identity. Its private key is reconstructed only inside the TEE.                           |
| Action          | A content-addressed JavaScript bundle registered with Lit. Changing its code produces a new CID.                  |
| Group           | Grants selected actions access to selected PKPs.                                                                  |
| Usage API key   | Executes actions allowed by a group. It is not an account API key and cannot manage billing.                      |

Never commit account API keys, usage API keys, or admin private keys. Usage API
key values are only displayed when created; save them in the appropriate
secret store immediately.

## Account modes

The action-package setup scripts support two Lit account modes:

| Mode            | Administration                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-key`       | Lit's managed API payer authorizes account changes. Only `--account-api-key` is required.                                                      |
| `chain-secured` | An on-chain admin wallet authorizes account changes. Use `--private-key` for a locally owned wallet or `--calldata` for an MPC/multisig owner. |

The same account API key continues to identify an account after it is converted
to ChainSecured mode. Its on-chain account hash is
`keccak256(toUtf8Bytes(accountApiKey))`.

## Action-package setup

Setup remains in each action package because the package knows which bundles,
environment configuration, group names, and usage-key names it owns. Both
scripts use the shared setup implementation exported from
`@relay-protocol/lit-helpers/setup`.

```sh
# Managed account
yarn workspace @relay-protocol/lit-allocator setup -- \
  --env dev --mode api-key \
  --account-api-key <account-api-key> \
  --create-pkp

# Wallet-owned ChainSecured account
yarn workspace @relay-protocol/lit-deposit-address setup -- \
  --env dev --mode chain-secured \
  --account-api-key <account-api-key> \
  --private-key 0x<admin-key> \
  --pkp-id 0x<existing-pkp>
```

Every setup run requires exactly one of:

- `--create-pkp`, which creates a new PKP; or
- `--pkp-id <address>`, which reuses an existing PKP owned by the account.

Setup is idempotent. It discovers the existing account resources, creates or
updates the package's group, registers the current action CIDs, removes stale
package-owned action registrations, grants the group access to the PKP, and
creates the environment usage API key if it is missing.

Use `--dry-run` to print the required changes without writing anything. Use
`--calldata` for an MPC/multisig-owned ChainSecured account as described below.

## Calldata mode for MPC or multisig owners

Once a ChainSecured account is owned by an MPC or multisig wallet, there is no
local admin private key. Pass `--calldata` instead of `--private-key` or
`--admin-private-key`. The command reads current state and prints the required
contract calls as `{ to, value, data }` objects and as a JSON batch. Relay that
batch through the current owner; its address must be `msg.sender` when the calls
execute.

```sh
yarn workspace @relay-protocol/lit-allocator setup -- \
  --env dev --mode chain-secured --calldata \
  --account-api-key <account-api-key> \
  --pkp-id 0x<existing-pkp>
```

Calldata mode is idempotent and emits nothing when the account is already in
sync. It cannot create PKPs or usage API keys because those API operations
require a live admin EIP-712 signature. Create them before transferring the
account to the MPC/multisig owner.

Calldata mode is supported by both action-package `setup` scripts and by the
`transfer-ownership`, `top-up-usage-key`, and `remove-usage-key` commands in
this package.

## Account commands

Run all commands from the repository root.

### Create PKPs

Create one or more PKPs and print their addresses. PKP key material is
generated by Lit's MPC system; the private key is not returned.

```sh
# Managed account
yarn workspace @relay-protocol/lit-helpers create-pkp -- \
  --mode api-key \
  --account-api-key <account-api-key> \
  --count 1

# Wallet-owned ChainSecured account
yarn workspace @relay-protocol/lit-helpers create-pkp -- \
  --mode chain-secured \
  --account-api-key <account-api-key> \
  --private-key 0x<admin-key> \
  --count 2 \
  --name "Allocator PKP"
```

PKP creation cannot run in calldata mode. Create the required PKPs before
transferring account ownership to an MPC or multisig.

### Convert an account to ChainSecured

Convert a managed account so an admin wallet controls future account changes.
Groups, actions, PKPs, usage keys, billing, and the original account API key
remain attached to the account.

```sh
yarn workspace @relay-protocol/lit-helpers convert-to-chain-secured -- \
  --account-api-key <account-api-key> \
  --new-admin-private-key 0x<new-admin-key>
```

After conversion, group, action, PKP, and usage-key changes must be authorized
by the ChainSecured admin.

### Transfer ChainSecured ownership

Transfer an account from its current admin wallet to another address:

```sh
yarn workspace @relay-protocol/lit-helpers transfer-ownership -- \
  --account-api-key <account-api-key> \
  --current-admin-private-key 0x<current-admin-key> \
  --new-admin-address 0x<new-admin-address>
```

If both private keys are available, `--new-admin-private-key` can replace
`--new-admin-address`; the command derives the new address locally. For an
MPC/multisig current owner, omit the current key and emit calldata:

```sh
yarn workspace @relay-protocol/lit-helpers transfer-ownership -- \
  --account-api-key <account-api-key> \
  --calldata \
  --new-admin-address 0x<new-admin-address>
```

The new admin must be non-zero, differ from the current admin, and not already
administer another account. The account API key, billing wallet, credits,
groups, actions, PKPs, and usage keys are preserved.

### Verify ChainSecured ownership

Check whether an address is the current admin without broadcasting a
transaction:

```sh
yarn workspace @relay-protocol/lit-helpers verify-ownership -- \
  --account-api-key <account-api-key> \
  --admin-address 0x<candidate-admin-address>
```

Use `--admin-private-key 0x<candidate-key>` instead of `--admin-address` to
derive the candidate address locally. The command uses `eth_call`; it does not
sign or broadcast a transaction.

### List account resources

List usage API keys, groups, action and PKP permissions, and the PKPs attached
to groups:

```sh
yarn workspace @relay-protocol/lit-helpers list-account -- \
  --account-api-key <account-api-key>
```

Add `--json` for machine-readable output.

## Billing commands

### Read account credits

```sh
yarn workspace @relay-protocol/lit-helpers credits -- \
  --account-api-key <account-api-key>
```

The command reads the account-level credit balance used for API requests.
`balance_cents` is negative when credit remains, zero when exhausted, and
positive when an amount is owed.

Account credits are separate from a ChainSecured usage API key's on-chain
`balance` and `expiration`. Both must permit execution.

### Add account credits

```sh
yarn workspace @relay-protocol/lit-helpers top-up -- \
  --account-api-key <account-api-key> \
  --amount-cents 2500
```

The command opens Lit's Stripe checkout flow in a local browser and confirms
the payment with Lit after settlement. The account API key is required; a usage
API key has no billing permission. The minimum amount is 500 cents.

## Usage API key commands

### Top up or extend a ChainSecured usage key

ChainSecured usage keys have on-chain `balance` and `expiration` fields. An
empty balance or expired key causes action execution to fail even if the Lit
account has billing credits.

```sh
yarn workspace @relay-protocol/lit-helpers top-up-usage-key -- \
  --account-api-key <account-api-key> \
  --admin-private-key 0x<admin-key> \
  --name <usage-key-name> \
  --reset-expiration
```

Options:

- `--balance <uint256>` sets a specific balance;
- `--expiration <unix-seconds>` sets an absolute expiration;
- `--lifetime-seconds <n>` sets a relative lifetime;
- `--reset-expiration` restores the default ten-year lifetime;
- `--preserve-balance` keeps the current balance unchanged.

Replace `--admin-private-key` with `--calldata` for an MPC/multisig owner.

### Rotate a usage API key

Lit cannot display an existing usage-key secret again. If it is lost or must be
rotated, remove its on-chain entry and rerun the relevant action-package setup
command to create a new secret with the same canonical name.

```sh
yarn workspace @relay-protocol/lit-helpers remove-usage-key -- \
  --account-api-key <account-api-key> \
  --admin-private-key 0x<admin-key> \
  --name <usage-key-name>

yarn workspace @relay-protocol/lit-deposit-address setup -- \
  --env dev --mode chain-secured \
  --account-api-key <account-api-key> \
  --private-key 0x<admin-key> \
  --pkp-id 0x<existing-pkp>
```

Replace `--admin-private-key` with `--calldata` for an MPC/multisig owner.

## Troubleshooting

| Symptom                                      | Check or fix                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 401 or 403 from Lit                     | Confirm that the caller uses the environment's usage API key, not its account API key, and that the key can execute the action group. |
| HTTP 402 from Lit                            | Check both account credits and the ChainSecured usage key's on-chain balance and expiration.                                          |
| Action CID is not authorized                 | Rerun the action package's `setup --dry-run`; the new CID may not be registered or attached to the group.                             |
| `--pkp-id` is not found                      | The PKP belongs to a different Lit account or the wrong account API key was supplied.                                                 |
| ChainSecured write is rejected               | Verify the current admin with `verify-ownership`; calldata must be relayed with that admin as `msg.sender`.                           |
| Setup finds a usage key but prints no secret | Existing secrets cannot be read again. Remove the usage key and rerun setup to rotate it.                                             |
| `--calldata` prints no calls                 | The requested resources are already in sync; no transaction is required.                                                              |

## Development

```sh
yarn workspace @relay-protocol/lit-helpers build
yarn workspace @relay-protocol/lit-helpers lint
yarn workspace @relay-protocol/lit-helpers format:check
```
