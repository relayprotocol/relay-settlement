/** Lighter-specific build-time configuration. Imported only by the Lighter action. */
declare const __LIGHTER_GATEWAYS__: string;

/** One Lighter deployment this action may register API keys on. */
export interface LighterGateway {
  /** EIP-155 chain id of the L1 hosting the gateway; selects the entry and signs the transaction. */
  chainId: number;
  /** ZkLighter gateway contract address on that L1. */
  gateway: string;
  /** API keys this action may register on this gateway via ChangePubKey. */
  allowedApiKeys: Array<{
    apiKeyIndex: number;
    publicKey: string;
  }>;
}

/** Lighter gateways compiled into this environment, keyed by L1 chain id. */
export const LIGHTER_GATEWAYS = JSON.parse(__LIGHTER_GATEWAYS__) as LighterGateway[];
