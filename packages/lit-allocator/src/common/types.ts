/** RelayAllocatorV2 withdraw request fields passed to both the oracle and the Lit Action. */
export interface WithdrawRequest {
  /** Chain identifier of the destination chain, e.g. "ethereum-mainnet". */
  chainId: string;
  /** Hex-encoded depository contract address on the destination chain. */
  depository: string;
  /** Hex-encoded currency address on the destination chain. */
  currency: string;
  /** Decimal string amount of currency to withdraw. */
  amount: string;
  /** Chain identifier of the spender chain. */
  spenderChainId: string;
  /** Hex-encoded spender address. */
  spender: string;
  /** Hex-encoded receiver address. */
  receiver: string;
  /** Hex-encoded additional calldata for the depository. */
  data: string;
  /** Hex-encoded 32-byte nonce for replay protection. */
  nonce: string;
}

/** A single oracle signature over a WithdrawRequestAttestation. */
export interface WithdrawRequestAttestationSignature {
  /** Checksummed Ethereum address of the signing oracle node. */
  oracleSigner: string;
  /** EIP-712 signature over the WithdrawRequest typed data. */
  signature: string;
}

/**
 * Attestation returned by POST /attestations/withdraw-requests/v1.
 *
 * The oracle resolves the requested hashesToSign on-chain (looking up
 * `allocator.hashesToSign[withdrawRequestHash][hashIndex]` for each requested
 * index) and signs the result with EIP-712 so the Lit Action can verify it
 * trustlessly and produce one signature per requested hash.
 */
export interface WithdrawRequestAttestation {
  /** Hub EVM chain ID. */
  chainId: number;
  /** Allocator contract address on the hub chain. */
  allocator: string;
  /** keccak256(abi.encode(withdrawRequest)) as a 0x-prefixed hex string. */
  withdrawRequestHash: string;
  /** Hashes the oracle attests should be signed for this withdraw request. */
  hashesToSign: string[];
  /** Oracle EIP-712 signatures attesting to the above fields. */
  signatures: WithdrawRequestAttestationSignature[];
}
