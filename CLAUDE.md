# Relay Settlement Protocol

Multi-chain settlement protocol. Monorepo using Yarn v4 workspaces.

This is a **public repository**. All code, commits, PR descriptions, and comments are visible to the world. Keep this in mind:

- Never commit secrets, private keys, internal URLs, or proprietary information.
- Use clear, professional naming — no internal jargon, placeholder names, or obscure abbreviations.
- READMEs and documentation matter. Update them when behavior changes.

## Project Structure

- `smart-contracts/` — Solidity 0.8.28 contracts (Allocator, Hub, Oracle, PayloadBuilders, MultisigSigner)
- `packages/` — TypeScript packages:
  - `abis` — Exported contract ABIs
  - `sdk` — Settlement SDK
  - `networks` — Network configurations (85+ chains)
  - `hub-client` — Hub interaction client
  - `hub-utils` — Helper utilities
  - `fixtures` — Test fixtures
  - `types` — Shared TypeScript types
  - `eslint-config` — Shared ESLint config
  - `tsconfig` — Shared TypeScript config
- `docs/` — Documentation and audit reports

## Commands

From repo root:

- `yarn install` — Install all workspace dependencies
- `yarn build` — Build all packages and smart contracts
- `yarn test` — Run all workspace tests
- `yarn lint` — Lint all workspaces

From `smart-contracts/`:

- `yarn build` — Compile Solidity contracts
- `yarn test` — Run Mocha/Chai test suite
- `yarn coverage` — Generate solidity-coverage report
- `yarn lint` — Solhint + ESLint + Prettier check
- `yarn lintFix` — Auto-fix lint and formatting

## Workflow

- NEVER push directly to main. Always open a PR.
- Branch naming: `feat/`, `fix/`, `chore/`, `test/` prefixes.
- Commits: use Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`). Keep messages imperative and scoped.
- PRs must pass `yarn lint` and `yarn test` before merging.
- Include purpose, linked issues, and how to test in PR descriptions.

## Code Style

- Solidity: Prettier with `prettier-plugin-solidity`, Solhint per `.solhint.json`.
- TypeScript: ESLint via `@relay-settlement/eslint-config`, double quotes, no semicolons, trailing commas (es5).
- File naming: Solidity contracts in `PascalCase.sol`, TypeScript files in `camelCase.ts`.
- Match the style of surrounding code. Run `yarn lintFix` before committing.

## Testing

- Smart contracts: Mocha + Chai + Hardhat (viem). Use `loadFixture` for deterministic deployments.
- Test location: `test/<Contract>/<feature>.ts` with descriptive `describe/it` blocks.
- TypeScript packages: Vitest.
- Prefer running single test files over the full suite during development.

## Security

- Never commit secrets. Use `.env` files (gitignored) for `DEPLOYER_PRIVATE_KEY`, `RPC_URL`, etc.
- Do not edit generated folders (`artifacts/`, `cache/`, `ignition/deployments/`) manually.
- Review diffs before committing to ensure no sensitive data leaks into this public repo.
