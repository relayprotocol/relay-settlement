# Lit Action deployment checklist

Use this checklist for every source, dependency, or environment-config change
in `lit-allocator` or `lit-deposit-address`. Run it separately for each affected
environment.

## 1. Validate the source package

```sh
# Choose one workspace
ACTION_WORKSPACE=@relay-protocol/lit-allocator
# ACTION_WORKSPACE=@relay-protocol/lit-deposit-address

yarn workspace $ACTION_WORKSPACE test
yarn workspace $ACTION_WORKSPACE lint
yarn workspace $ACTION_WORKSPACE bundle:actions -- --env <env>
```

Review the generated files under `dist/actions/<env>/`. A changed file means a
changed CID.

## 2. Preview the Lit registration

Use the existing PKP. Creating a new PKP changes the derived protocol wallets.

```sh
# Managed account
yarn workspace $ACTION_WORKSPACE setup -- \
  --env <env> --mode api-key \
  --account-api-key <account-api-key> \
  --pkp-id <existing-pkp> \
  --dry-run

# Wallet-owned ChainSecured account
yarn workspace $ACTION_WORKSPACE setup -- \
  --env <env> --mode chain-secured \
  --account-api-key <account-api-key> \
  --private-key 0x<admin-key> \
  --pkp-id <existing-pkp> \
  --dry-run
```

Confirm the environment, PKP, changed CIDs, and actions that will be replaced.
For an MPC/multisig-owned account, use the
[`--calldata` flow](../lit-helpers#calldata-mode-for-mpc-or-multisig-owners)
instead of `--dry-run` for the final transaction batch.

## 3. Register the new bundles

Rerun the same command without `--dry-run`. Save its printed action CIDs and
verify the expected actions are attached to the environment group:

```sh
yarn workspace @relay-protocol/lit-helpers list-account -- \
  --account-api-key <account-api-key>
```

## 4. Package the released code

Update the version/environment/VM matrix in `scripts/generate-actions.ts` when
needed, then build the release package:

```sh
yarn workspace @relay-protocol/lit-actions build
```

Generation compares the new bundles with the latest published package and
prints every changed config or VM bundle. Review those warnings before
publishing `@relay-protocol/lit-actions`.

## 5. Update and test every caller

For each service that executes the action:

1. adopt the new `@relay-protocol/lit-actions` version;
2. update configured CIDs if the service stores them;
3. keep the same environment and PKP id unless the change intentionally
   rotates wallets;
4. execute `wallet` or `account` and confirm the expected address/public root;
5. complete one real end-to-end signing flow in that environment; and
6. switch traffic only after the signed payload succeeds on the target chain.

The deployment is incomplete until all callers use the new bundle.

## Rollback

Keep the previous package version, commit, and CIDs until the new integration
passes. To roll back, rebuild the previous source for the environment, rerun
its package `setup` command with the same PKP, restore the previous caller
package/CID configuration, and repeat the smoke test.
