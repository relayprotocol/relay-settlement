import { hkdf } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/hkdf.js/+esm#sha384-atC652lJHdy2mGTLUvqHi6AeMHDB2bL7pxTnWm60MnCozQQNDB0rCTnwCNlnHXa+";
import { ripemd160 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/legacy.js/+esm#sha384-W5rl1BQJyzEdXXWSB4DFDli1JRA3C/SHvAHbotjb/54rfbErbxPkCzqckaLRTzrH";
import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm#sha384-fpq5UdD7vTx0NhDc6RRBoykedv2HsZB3RxSOX130Tk6qLqG1jtQzuXISijyF++FS";
import { keccak_256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha3.js/+esm#sha384-d6IJ7/Jw0smuX8ORKVtzFUn742oCennYdN8wjABB8IrPwvdnYNgq8R7Q3jm19qVG";
import { utf8ToBytes } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/utils.js/+esm#sha384-81Ys7folK9g1yP638SSxYBut5/EduVcZkl91gBJkPC/7ox5wD+2MJVne2gymPq4f";

/**
 * HKDF domain separator. Bumping this invalidates every previously derived
 * deposit address, so it should be treated as a stable protocol constant.
 */
const DOMAIN_SEPARATOR = "lit-deposit-addresses";

/**
 * Derive a 64-byte seed for a specific VM from the PKP root key, using
 * HKDF-SHA256 with the VM family as the info parameter. Different VMs
 * therefore get independent seeds even though they share a root key.
 */
export function deriveVmSeed(rootKey: Uint8Array, vmType: string): Uint8Array {
  return hkdf(sha256, rootKey, utf8ToBytes(DOMAIN_SEPARATOR), utf8ToBytes(vmType), 64);
}

/** Bitcoin's `HASH160 = RIPEMD160(SHA256(data))`. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/** Ethereum's `keccak256` hash. */
export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}
