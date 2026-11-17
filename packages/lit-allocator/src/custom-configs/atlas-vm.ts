/** Atlas-specific build-time configuration. Imported only by the Atlas action. */
declare const __ATLAS_DOMAIN__: string;

/** Deployment-specific fields of the Atlas EIP-712 signing domain. */
export interface AtlasDomain {
  /** EIP-712 domain `chainId` of the Atlas deployment (not an EVM network id). */
  chainId: number;
  /** EIP-712 domain `salt` of the Atlas deployment. */
  salt: string;
}

/** Atlas domain compiled into this environment, or null when Atlas isn't supported. */
export const ATLAS_DOMAIN = JSON.parse(__ATLAS_DOMAIN__) as AtlasDomain | null;
