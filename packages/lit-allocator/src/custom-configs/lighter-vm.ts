/** Lighter-specific build-time configuration. Imported only by the Lighter action. */
declare const __LIGHTER_ALLOWED_API_KEYS__: string;
declare const __LIGHTER_GATEWAY__: string;
declare const __LIGHTER_GATEWAY_CHAIN_ID__: string;

/** Lighter API keys this action may register via ChangePubKey. */
export const LIGHTER_ALLOWED_API_KEYS = JSON.parse(__LIGHTER_ALLOWED_API_KEYS__) as Array<{
  apiKeyIndex: number;
  publicKey: string;
}>;

/** Lighter gateway contract address on the gateway chain. */
export const LIGHTER_GATEWAY = __LIGHTER_GATEWAY__;
/** EIP-155 gateway chain id used for Lighter ChangePubKey transactions. */
export const LIGHTER_GATEWAY_CHAIN_ID = Number.parseInt(__LIGHTER_GATEWAY_CHAIN_ID__, 10);
