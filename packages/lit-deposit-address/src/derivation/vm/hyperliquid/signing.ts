import { bytesToHex } from "../../../common/bytes.js";
import { hashTypedData, signTypedDataHash } from "../../../common/eip712.js";
import type { HyperliquidVmSendAsset, HyperliquidVmNonceMapping } from "../../../common/types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Deposit addresses are EOAs, so the EIP-712 domain chainId doesn't affect
// signature validity in any meaningful way (an EOA signature recovers to
// the same address regardless of the chain it claims to be from). We pin
// this to 1 for simplicity.
const NONCE_MAPPING_DOMAIN_CHAIN_ID = 1;

const NONCE_MAPPING_TYPES = {
  NonceMapping: [
    { name: "chainId", type: "string" },
    { name: "wallet", type: "address" },
    { name: "depositor", type: "address" },
    { name: "id", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
};

const SEND_ASSET_TYPES = {
  "HyperliquidTransaction:SendAsset": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "sourceDex", type: "string" },
    { name: "destinationDex", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "fromSubAccount", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
};

export function signNonceMapping(message: HyperliquidVmNonceMapping, privateKey: Uint8Array) {
  const digest = hashTypedData({
    domain: {
      name: "RelayNonceMapping",
      version: "2",
      chainId: NONCE_MAPPING_DOMAIN_CHAIN_ID,
      verifyingContract: ZERO_ADDRESS,
    },
    types: NONCE_MAPPING_TYPES,
    primaryType: "NonceMapping",
    message: {
      chainId: message.walletChainId,
      wallet: message.wallet,
      depositor: message.depositor,
      id: message.id,
      nonce: BigInt(message.nonce),
    },
  });
  return { digest: `0x${bytesToHex(digest)}`, signature: signTypedDataHash(digest, privateKey) };
}

export function signSendAsset(message: HyperliquidVmSendAsset, privateKey: Uint8Array) {
  const digest = hashTypedData({
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: Number.parseInt(message.signatureChainId),
      verifyingContract: ZERO_ADDRESS,
    },
    types: SEND_ASSET_TYPES,
    primaryType: "HyperliquidTransaction:SendAsset",
    message: {
      ...message,
      nonce: BigInt(message.nonce),
    } as unknown as Record<string, unknown>,
  });
  return { digest: `0x${bytesToHex(digest)}`, signature: signTypedDataHash(digest, privateKey) };
}
