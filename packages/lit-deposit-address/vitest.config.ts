import { defineConfig } from "vitest/config";

/**
 * The source files import every external dependency via jsDelivr `+esm` URLs
 * so the bundled Lit Action doesn't ship dependency source code. For tests we
 * alias those URLs back to the locally installed npm packages so Node/Vitest
 * can resolve them normally.
 */
export default defineConfig({
  resolve: {
    alias: {
      "https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm": "viem",
      "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm": "@metamask/key-tree",
      "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm":
        "@noble/curves/secp256k1.js",
      "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/ed25519.js/+esm":
        "@noble/curves/ed25519.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/utils.js/+esm": "@noble/hashes/utils.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm": "@noble/hashes/sha2.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha3.js/+esm": "@noble/hashes/sha3.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/hkdf.js/+esm": "@noble/hashes/hkdf.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/legacy.js/+esm": "@noble/hashes/legacy.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/pbkdf2.js/+esm": "@noble/hashes/pbkdf2.js",
      "https://cdn.jsdelivr.net/npm/@scure/base@2.0.0/+esm": "@scure/base",
      "https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm": "bs58",
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Solana derivation runs PBKDF2 at 4096 iterations and routinely brushes
    // up against vitest's 5s default under parallel test load. Raise the
    // per-test ceiling so those derivation suites don't flake.
    testTimeout: 15_000,
    server: {
      deps: {
        inline: [/@noble\/.*/],
      },
    },
  },
});
