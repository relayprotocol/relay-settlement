# lit-helpers

Action-agnostic helpers for Lit/Chipotle accounts.

Run the account-management scripts directly from the `@relay-protocol/lit-helpers` workspace; they are not exposed through the Lit action packages. All scripts that authenticate with Chipotle use the account API key via `--account-api-key`.

This package also exports shared setup backends from `@relay-protocol/lit-helpers/setup` for Lit action packages that need to provision Chipotle groups, PKPs, actions, and usage keys.

## Scripts

### Convert an account to ChainSecured

```sh
yarn workspace @relay-protocol/lit-helpers convert-to-chain-secured -- \
  --account-api-key <account-api-key> \
  --new-admin-private-key 0x<new-admin-wallet-key>
```

### Transfer ChainSecured account ownership

```sh
yarn workspace @relay-protocol/lit-helpers transfer-ownership -- \
  --account-api-key <account-api-key> \
  --current-admin-private-key 0x<current-admin-wallet-key> \
  --new-admin-address 0x<new-admin-wallet-address>
```

Alternatively, derive the new admin address from a private key:

```sh
yarn workspace @relay-protocol/lit-helpers transfer-ownership -- \
  --account-api-key <account-api-key> \
  --current-admin-private-key 0x<current-admin-wallet-key> \
  --new-admin-private-key 0x<new-admin-wallet-key>
```

### Verify ChainSecured ownership

```sh
yarn workspace @relay-protocol/lit-helpers verify-ownership -- \
  --account-api-key <account-api-key> \
  --admin-address 0x<candidate-admin-address>
```

Alternatively, derive the candidate admin address from a private key:

```sh
yarn workspace @relay-protocol/lit-helpers verify-ownership -- \
  --account-api-key <account-api-key> \
  --admin-private-key 0x<candidate-admin-key>
```

### Read credits

```sh
yarn workspace @relay-protocol/lit-helpers credits -- --account-api-key <account-api-key>
```

### Top up credits

```sh
yarn workspace @relay-protocol/lit-helpers top-up -- \
  --account-api-key <account-api-key> \
  --amount-cents 2500
```

### Top up a usage API key's on-chain balance

ChainSecured usage API keys have on-chain `balance` and `expiration` fields
that Chipotle meters `/lit_action` calls against. Newly minted keys are
seeded with `balance = 10_000_000` and `expiration = now + 10 years`; if an
older key was minted with `0` (or has been drained / expired), executions
fail with HTTP 402 even when the account has billing credits. Re-issue the
key with a fresh balance and/or expiration:

```sh
# Just refill the balance (expiration preserved)
yarn workspace @relay-protocol/lit-helpers top-up-usage-key -- \
  --account-api-key <account-api-key> \
  --admin-private-key 0x<admin-key> \
  --name <usage-key-name>

# Refill balance and reset the expiration to the default 10-year lifetime
yarn workspace @relay-protocol/lit-helpers top-up-usage-key -- \
  --account-api-key <account-api-key> \
  --admin-private-key 0x<admin-key> \
  --name <usage-key-name> \
  --reset-expiration
```

Pass `--balance <uint256>` to override the default balance, and one of
`--expiration <unix-seconds>`, `--lifetime-seconds <n>`, or
`--reset-expiration` to change the expiration. The script reads every other
field of the existing entry on-chain and re-submits `setUsageApiKey` with
only those values changed.

### Remove (and re-mint) a usage API key

When you need a brand-new secret value (e.g. the original was lost or you
want to rotate it), delete the on-chain entry first and then re-run the
action package's `setup` script to mint a fresh one:

```sh
yarn workspace @relay-protocol/lit-helpers remove-usage-key -- \
  --account-api-key <account-api-key> \
  --admin-private-key 0x<admin-key> \
  --name <usage-key-name>

# Then re-mint with a fresh secret + default 10M balance + 10-year expiration
yarn workspace @relay-protocol/lit-deposit-address setup -- \
  --env <env> --mode chain-secured \
  --account-api-key <account-api-key> --private-key 0x<admin-key> \
  --pkp-id 0x<existing-pkp>
```

`remove-usage-key` calls the `removeUsageApiKey` facet on the AccountConfig
diamond, which deletes the entry and clears its reverse mapping so the same
name (or even the same secret) can be re-registered afterwards.

### List account resources

List usage API keys, group permissions, actions, and PKP wallets linked to groups. Group permissions show which PKPs and actions are allowed in each group, plus which usage API keys can execute/manage that group.

```sh
yarn workspace @relay-protocol/lit-helpers list-account -- --account-api-key <account-api-key>
```

For machine-readable output:

```sh
yarn workspace @relay-protocol/lit-helpers list-account -- --account-api-key <account-api-key> --json
```
