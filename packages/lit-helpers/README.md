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

### List account resources

List usage API keys, group permissions, actions, and PKP wallets linked to groups. Group permissions show which PKPs and actions are allowed in each group, plus which usage API keys can execute/manage that group.

```sh
yarn workspace @relay-protocol/lit-helpers list-account -- --account-api-key <account-api-key>
```

For machine-readable output:

```sh
yarn workspace @relay-protocol/lit-helpers list-account -- --account-api-key <account-api-key> --json
```
