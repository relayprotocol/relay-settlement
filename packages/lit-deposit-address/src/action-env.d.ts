declare const Lit: {
  Actions: {
    getPrivateKey(args: { pkpId: string }): Promise<string>;
    setResponse(args: { response: string }): void;
  };
};

// ─── jsDelivr ESM URL imports ───────────────────────────────────────────────
// Each URL re-exports its locally installed npm package so TypeScript can
// keep type-checking the source files without bundling the dependency.

declare module "https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm#sha384-YppD9Zm3WvzBC3kmMreLoS2VRCnN1bgrD8Ai2tGMcfMQsNoKMdWqL+ToE+kej/ys" {
  export * from "viem";
}

declare module "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm#sha384-iWbSDJToETb8472qJVfgUl0vgl03s8An4v0EtHgKVwHrYQFjgbPU8Xu9n83+plLN" {
  export * from "@metamask/key-tree";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm#sha384-EtK9grXXeMKBkEYOQQfnqbuL27d6fm62SvYWp0bXat9Nh0VIK6vdGAqidcU/3m+d" {
  export * from "@noble/curves/secp256k1.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/ed25519.js/+esm#sha384-Bdcn5+otxW5DZgXyuQ8l2JyyG6Op7ZzGm5KrBjD0Q/8vkBtT4KsX7abNZPcelj2p" {
  export * from "@noble/curves/ed25519.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/utils.js/+esm#sha384-81Ys7folK9g1yP638SSxYBut5/EduVcZkl91gBJkPC/7ox5wD+2MJVne2gymPq4f" {
  export * from "@noble/hashes/utils.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm#sha384-fpq5UdD7vTx0NhDc6RRBoykedv2HsZB3RxSOX130Tk6qLqG1jtQzuXISijyF++FS" {
  export * from "@noble/hashes/sha2.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha3.js/+esm#sha384-d6IJ7/Jw0smuX8ORKVtzFUn742oCennYdN8wjABB8IrPwvdnYNgq8R7Q3jm19qVG" {
  export * from "@noble/hashes/sha3.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/hkdf.js/+esm#sha384-atC652lJHdy2mGTLUvqHi6AeMHDB2bL7pxTnWm60MnCozQQNDB0rCTnwCNlnHXa+" {
  export * from "@noble/hashes/hkdf.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/legacy.js/+esm#sha384-W5rl1BQJyzEdXXWSB4DFDli1JRA3C/SHvAHbotjb/54rfbErbxPkCzqckaLRTzrH" {
  export * from "@noble/hashes/legacy.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/pbkdf2.js/+esm#sha384-D5VIsA1sKtlUy0alXi0qwfCSsGkk/yblfbRQCtvHiyLjsS8FbWSPqf5Ot1CVMXsZ" {
  export * from "@noble/hashes/pbkdf2.js";
}

declare module "https://cdn.jsdelivr.net/npm/@scure/base@2.0.0/+esm#sha384-Tw6lJWVcnorbAhNG1S0uWwn2pRShQPG6VN+IAvK+uVz3B5VPYxJoeuKo6IlfFljz" {
  export * from "@scure/base";
}

declare module "https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm#sha384-obRIzJpHEltALtaRu+VVERKw4iCzb8EUZaHzlyuZvEbHzDKHIiaO0940L3FlRjee" {
  import bs58 from "bs58";
  export default bs58;
}
