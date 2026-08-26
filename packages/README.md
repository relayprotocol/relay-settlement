# Packages

The `packages/` directory contains the Relay Settlement Protocol's published
TypeScript libraries, internal services, contract implementations, command-line
tools, shared configuration, and Lit Action tooling. These directories are
managed by the root Yarn workspace unless noted otherwise.

| Directory                                      | Package                               | Purpose                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`abis`](./abis)                               | `@relay-protocol/settlement-abis`     | Publishes the protocol's current and historical contract ABIs as plain arrays for contract calls, event queries, and transaction decoding                |
| [`depository`](./depository)                   | N/A                                   | Contains the Ethereum and Solana Relay Depository contract implementations for receiving deposits and executing allocator-authorized withdrawals         |
| [`eslint-config`](./eslint-config)             | `@relay-settlement/eslint-config`     | Provides the shared ESLint flat config and the `lint` command used across the monorepo, including Prettier and repository-specific rules                 |
| [`indexer`](./indexer)                         | `@relay-settlement/indexer`           | Runs the PostgreSQL-backed settlement indexer and API, including transfer ingestion, balance and coverage audits, and bounded replay tooling             |
| [`indexer-ui`](./indexer-ui)                   | `@relay-settlement/indexer-ui`        | Provides the React/Vite UI for browsing indexed addresses and tokens, viewing indexer health, and operating transfer replays                             |
| [`lit-actions`](./lit-actions)                 | `@relay-protocol/lit-actions`         | Publishes the supported allocator and deposit-address Lit Action bundles together with their environment configuration and typed lookup helpers          |
| [`lit-allocator`](./lit-allocator)             | `@relay-protocol/lit-allocator`       | Implements and provisions environment-specific Lit Actions that derive allocator wallets and sign oracle-attested withdrawal hashes across supported VMs |
| [`lit-deposit-address`](./lit-deposit-address) | `@relay-protocol/lit-deposit-address` | Implements deterministic multi-VM deposit wallet derivation, public child derivation, transaction policy checks, and Lit Action signing                  |
| [`lit-helpers`](./lit-helpers)                 | `@relay-protocol/lit-helpers`         | Provides shared Chipotle setup backends and account-management CLIs for PKPs, ownership, credits, groups, and usage API keys                             |
| [`multisig-tools`](./multisig-tools)           | `@relay-settlement/multisig-tools`    | Provides the off-chain CLI and libraries for building, simulating, approving, submitting, checking, and executing cross-VM multisig transactions         |
| [`networks`](./networks)                       | `@relay-protocol/settlement-networks` | Publishes supported-chain metadata, RPC and explorer configuration, and environment-specific protocol contract addresses                                 |
| [`sdk`](./sdk)                                 | `@relay-protocol/settlement-sdk`      | Publishes shared protocol types and cross-VM codecs for orders, addresses, transactions, signatures, and payloads                                        |
| [`tsconfig`](./tsconfig)                       | `@relay-settlement/tsconfig`          | Provides the base TypeScript compiler configuration shared by monorepo packages                                                                          |

Run package commands from the repository root with
`yarn workspace <package-name> <command>`. The root `yarn build`, `yarn test`,
and `yarn lint` commands operate across the workspaces.
