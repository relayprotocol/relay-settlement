declare const Lit: {
  Actions: {
    getPrivateKey(args: { pkpId: string }): Promise<string>;
    setResponse(args: { response: string }): void;
  };
};

// ─── jsDelivr ESM URL imports ───────────────────────────────────────────────
// Each URL re-exports its locally installed npm package so TypeScript can
// keep type-checking the source files without bundling the dependency.

declare module "https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm" {
  export * from "viem";
}

declare module "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm" {
  export * from "@metamask/key-tree";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm" {
  export * from "@noble/curves/secp256k1.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/ed25519.js/+esm" {
  export * from "@noble/curves/ed25519.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/utils.js/+esm" {
  export * from "@noble/hashes/utils.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm" {
  export * from "@noble/hashes/sha2.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha3.js/+esm" {
  export * from "@noble/hashes/sha3.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/hkdf.js/+esm" {
  export * from "@noble/hashes/hkdf.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/legacy.js/+esm" {
  export * from "@noble/hashes/legacy.js";
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/pbkdf2.js/+esm" {
  export * from "@noble/hashes/pbkdf2.js";
}

declare module "https://cdn.jsdelivr.net/npm/@scure/base@2.0.0/+esm" {
  export * from "@scure/base";
}

declare module "https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm" {
  import bs58 from "bs58";
  export default bs58;
}
