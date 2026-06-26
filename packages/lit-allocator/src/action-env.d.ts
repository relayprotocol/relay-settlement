/**
 * Ambient type declarations for the Lit Action runtime.
 *
 * Lit Actions execute inside a TEE (Trusted Execution Environment) and load
 * their dependencies directly from jsDelivr ESM URLs at runtime. TypeScript
 * can't resolve those URLs, so this file declares minimal types for each
 * import the action source uses. Add a new `declare module` block here when
 * the action takes a new CDN dependency.
 *
 * The `Lit` global is injected by the Lit Action host and exposes a small
 * subset of host APIs (PKP key access, signing primitives, network calls).
 * Only the bits the actions actually call are declared.
 */

declare module "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm" {
  export const secp256k1: {
    getPublicKey(privateKey: Uint8Array, isCompressed?: boolean): Uint8Array;
  };
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/sha3/+esm" {
  export function keccak_256(message: Uint8Array): Uint8Array;
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/legacy.js/+esm" {
  export function ripemd160(message: Uint8Array): Uint8Array;
}

declare module "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm" {
  export function sha256(message: Uint8Array): Uint8Array;
}

declare module "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/+esm" {
  export const addr: {
    fromPrivateKey(privateKey: string): string;
    addChecksum(address: string): string;
  };
  export function verifyTyped(signature: string, typed: unknown, address: string): boolean;
}

declare module "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/utils.js/+esm" {
  export function sign(
    hash: Uint8Array,
    privKey: Uint8Array,
  ): {
    toBytes(format: "compact" | "recovered"): Uint8Array;
  };
}

declare module "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm" {
  const nacl: {
    sign: {
      keyPair: {
        fromSeed(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
      };
      detached(message: Uint8Array, secretKey: Uint8Array): Uint8Array;
    };
  };

  export default nacl;
}

declare module "https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm" {
  const bs58: {
    encode(bytes: Uint8Array): string;
  };

  export default bs58;
}

/**
 * Lit Action host runtime, injected as a global inside the TEE.
 *
 * Only the surface used by these allocator actions is declared. See the Lit
 * Action docs for the full API.
 */
declare const Lit: {
  Actions: {
    /** Reconstruct the PKP private key inside the TEE for the duration of this action run. */
    getPrivateKey(params: { pkpId: string }): Promise<string>;
  };
};
