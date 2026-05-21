import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __ALLOCATOR_ADDRESS__: JSON.stringify("0x1111111111111111111111111111111111111111"),
    __HUB_EVM_CHAIN_ID__: JSON.stringify("421614"),
    __ALLOWED_ORACLES__: JSON.stringify("[]"),
    __ORACLE_SIGNATURE_THRESHOLD__: JSON.stringify("0"),
  },
  resolve: {
    alias: {
      "https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/sha3/+esm": "@noble/hashes/sha3.js",
      "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/+esm": "micro-eth-signer",
      "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/utils.js/+esm":
        "micro-eth-signer/utils.js",
      "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm": "tweetnacl",
      "https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm": "bs58",
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Use the Node.js module resolution (not Vite's browser-oriented one)
    // This ensures @noble/* exports with .js extensions resolve correctly
    server: {
      deps: {
        inline: [/@noble\/.*/],
      },
    },
  },
});
