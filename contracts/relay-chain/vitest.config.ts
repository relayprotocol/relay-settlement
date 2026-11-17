import { resolve } from "path"
import { defineConfig } from "vitest/config"

// The deployment-verification tests import scripts that depend on the ABIs,
// SDK and networks workspaces. The Solidity CI job runs these tests without
// the TypeScript build outputs, so resolve the packages from source instead
// of their `dist/` entry points.
export default defineConfig({
  resolve: {
    alias: {
      "@relay-protocol/settlement-abis": resolve(
        __dirname,
        "../../packages/abis/src/index.ts"
      ),
      "@relay-protocol/settlement-networks": resolve(
        __dirname,
        "../../packages/networks/src/index.ts"
      ),
      "@relay-protocol/settlement-sdk": resolve(
        __dirname,
        "../../packages/sdk/src/index.ts"
      ),
    },
  },
  test: {
    environment: "node",
  },
})
