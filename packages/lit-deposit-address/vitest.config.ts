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
      "https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm#sha384-YppD9Zm3WvzBC3kmMreLoS2VRCnN1bgrD8Ai2tGMcfMQsNoKMdWqL+ToE+kej/ys":
        "viem",
      "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm#sha384-iWbSDJToETb8472qJVfgUl0vgl03s8An4v0EtHgKVwHrYQFjgbPU8Xu9n83+plLN":
        "@metamask/key-tree",
      "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm#sha384-EtK9grXXeMKBkEYOQQfnqbuL27d6fm62SvYWp0bXat9Nh0VIK6vdGAqidcU/3m+d":
        "@noble/curves/secp256k1.js",
      "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/ed25519.js/+esm#sha384-Bdcn5+otxW5DZgXyuQ8l2JyyG6Op7ZzGm5KrBjD0Q/8vkBtT4KsX7abNZPcelj2p":
        "@noble/curves/ed25519.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/utils.js/+esm#sha384-81Ys7folK9g1yP638SSxYBut5/EduVcZkl91gBJkPC/7ox5wD+2MJVne2gymPq4f":
        "@noble/hashes/utils.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm#sha384-fpq5UdD7vTx0NhDc6RRBoykedv2HsZB3RxSOX130Tk6qLqG1jtQzuXISijyF++FS":
        "@noble/hashes/sha2.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha3.js/+esm#sha384-d6IJ7/Jw0smuX8ORKVtzFUn742oCennYdN8wjABB8IrPwvdnYNgq8R7Q3jm19qVG":
        "@noble/hashes/sha3.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/hkdf.js/+esm#sha384-atC652lJHdy2mGTLUvqHi6AeMHDB2bL7pxTnWm60MnCozQQNDB0rCTnwCNlnHXa+":
        "@noble/hashes/hkdf.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/legacy.js/+esm#sha384-W5rl1BQJyzEdXXWSB4DFDli1JRA3C/SHvAHbotjb/54rfbErbxPkCzqckaLRTzrH":
        "@noble/hashes/legacy.js",
      "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/pbkdf2.js/+esm#sha384-D5VIsA1sKtlUy0alXi0qwfCSsGkk/yblfbRQCtvHiyLjsS8FbWSPqf5Ot1CVMXsZ":
        "@noble/hashes/pbkdf2.js",
      "https://cdn.jsdelivr.net/npm/@scure/base@2.0.0/+esm#sha384-Tw6lJWVcnorbAhNG1S0uWwn2pRShQPG6VN+IAvK+uVz3B5VPYxJoeuKo6IlfFljz":
        "@scure/base",
      "https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm#sha384-obRIzJpHEltALtaRu+VVERKw4iCzb8EUZaHzlyuZvEbHzDKHIiaO0940L3FlRjee":
        "bs58",
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
