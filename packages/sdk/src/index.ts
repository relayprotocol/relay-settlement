import {
  Order,
  OrderV2,
  encodeOrderCall,
  decodeOrderCall,
  encodeOrderExtraData,
  decodeOrderExtraData,
  getOrderId,
  getOrderV2Id,
} from "./order"

import {
  RoutedCall,
  RoutedWithdrawalData,
  ROUTED_WITHDRAWAL_DATA_VERSION,
  encodeRoutedWithdrawalData,
  decodeRoutedWithdrawalData,
  encodeRoutedCallsCalldata,
  hashRoutedCalls,
  multicallRouterAbi,
} from "./messages/common/ethereum-vm/routed"

import {
  ROUTED_TRANSFER_REQUEST_PREFIX,
  SolanaRoutedTransferRequest,
  decodeSolanaRoutedTransferRequest,
  encodeSolanaRoutedTransferRequest,
  getSolanaRoutedTransferRequestHash,
  getSolanaUsedRequestAddress,
} from "./messages/common/solana-vm/routed-transfer"

import {
  SOLANA_NATIVE_MINT,
  SOLANA_ROUTED_WITHDRAWAL_DATA_VERSION,
  SOLANA_ROUTER_BUNDLE_VERSION,
  SolanaBundleCall,
  SolanaCallAccount,
  SolanaRoutedWithdrawalData,
  SolanaRouterBundle,
  decodeSolanaRoutedWithdrawalData,
  decodeSolanaRouterBundle,
  encodeSolanaRoutedWithdrawalData,
  encodeSolanaRouterBundle,
  encodeSolanaRouterReleaseData,
  encodeSolanaRouterSettleData,
  getSolanaRouterAuthority,
  getSolanaRouterConfigAddress,
  getSolanaRouterDepositoryRole,
  encodeSolanaRouterInitializeData,
  encodeSolanaRouterGrantDepositoryRoleData,
  encodeSolanaRouterRevokeDepositoryRoleData,
  encodeSolanaRouterSetOwnerData,
  getSolanaRouterBundleAddress,
  getSolanaRouterBundleHash,
  getSolanaRouterBundlePda,
  toSolanaBundleFillMint,
  toSolanaBundleWithdrawMint,
} from "./messages/common/solana-vm/router"
import { RelayRouterIdl } from "./messages/common/solana-vm/idls/RelayRouterIdl"

import {
  decodeGatewaySolanaVmTransferRequest,
  encodeGatewaySolanaVmTransferRequest,
  GATEWAY_ROUTED_TRANSFER_REQUEST_PREFIX,
  GATEWAY_TRANSFER_REQUEST_PREFIX,
  GatewaySolanaVmTransferRequest,
  getGatewaySolanaVmTransferRequestHash,
  SOLANA_VM_GATEWAY_MINTER,
} from "./messages/v2.1/withdrawals/gateway-vm/solana-vm"

import {
  CallRequestWithdrawal,
  CommittedCallRequestWithdrawal,
  toExecutableCallRequest,
} from "./messages/v2.1/withdrawals/ethereum-vm"

import { DepositoryDepositMessage } from "./messages/v2.1/depository-deposit"

import {
  DecodedBitcoinVmWithdrawal,
  DecodedEthereumVmWithdrawal,
  DecodedGatewayVmWithdrawal,
  GatewayBurnIntent,
  GatewayTransferSpec,
  GatewayVmWithdrawal,
  getGatewayDestinationExpiration,
  getGatewayDestinationVmType,
  DecodedSolanaVmWithdrawal,
  DecodedHederaVmWithdrawal,
  DecodedHyperliquidVmWithdrawal,
  AtlasTransferParams,
  DecodedAtlasVmWithdrawal,
  DecodedLighterVmWithdrawal,
  DecodedTonVmWithdrawal,
  DecodedTronVmWithdrawal,
  DecodedXrpVmWithdrawal,
  DecodedWithdrawal,
  LighterTransferParams,
  PendingWithdrawalVmType,
  WithdrawalVmType,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  encodeWithdrawal,
  decodeWithdrawal,
  getDecodedWithdrawalId,
  buildLighterTransferL1Message,
  getHederaVmTransactionBody,
} from "./messages/v2.1/depository-withdrawal"

import {
  SolverRefundMessage,
  SolverRefundStatus,
} from "./messages/v2.1/solver-refund"

import {
  SolverFillMessage,
  SolverFillStatus,
} from "./messages/v2.1/solver-fill"

import {
  ActionType,
  ExecutionMessage,
  ExecutionMessageMetadata,
  encodeAction,
  decodeAction,
} from "./messages/v2.2/execution"

import {
  GenericMappingMessage,
  getGenericMappingMessageId,
  getNoFillOrRefundMessage,
  getNonceMappingMessage,
  getWithdrawParamsMappingMessage,
} from "./messages/v2.2/generic-mapping"

import { OrderAddressParams, getOrderAddress } from "./messages/v2.2/withdrawal"

import {
  DepositAddressTrigger,
  DepositAddressTriggerCurrency,
  DepositAddressTriggerDerivationFields,
  DepositAddressTriggerInput,
  DepositAddressTriggerPrice,
  getDepositAddressTriggerHash,
} from "./messages/v2.3/deposit-address"

import {
  WithdrawRequest,
  BitcoinVmWithdrawRequestAdditionalData,
  EthereumVmWithdrawRequestAdditionalData,
  GatewayVmWithdrawRequestAdditionalData,
  SolanaVmWithdrawRequestAdditionalData,
  WithdrawRequestAdditionalData,
  DenormalizedWithdrawRequest,
  ExecuteAndWithdrawFee,
  ExecuteAndWithdrawRequest,
  executeAndWithdrawRequestTypes,
  getExecuteAndWithdrawRequestHash,
  computeExecutionId,
  getWithdrawRequestHash,
  encodeWithdrawRequestAdditionalData,
  normalizeWithdrawRequest,
} from "./messages/v2.3/withdrawal"

import {
  DrawLeg,
  DrawLegKind,
  FundingPoolDrawAuthorization,
  FundingPoolDrawConfig,
  FundingPoolDrawConfigUpdate,
  FundingPoolDrawResolverUpdate,
  FundingPoolWithdrawal,
  PoolDrawResolverExecution,
  PoolResolverCall,
  fundingPoolDrawAuthorizationTypes,
  fundingPoolDrawConfigUpdateTypes,
  fundingPoolDrawResolverUpdateTypes,
  fundingPoolWithdrawalTypes,
  encodeFundingPoolDrawAuthorization,
  getFundingPoolDrawAuthorizationHash,
  getFundingPoolDrawConfigUpdateHash,
  getFundingPoolDrawResolverUpdateHash,
  getFundingPoolWithdrawalHash,
  getPoolDrawResolverCommitmentNonce,
  getPoolDrawResolverPlanHash,
  encodePoolDrawResolverExecution,
  encodePoolDrawResolverData,
  decodePoolDrawResolverData,
  decodePoolDrawResolverExecution,
} from "./messages/v2.3/funding-pool"
import {
  FundingPoolDrawRevocation,
  MAX_FUNDING_POOL_REVOCATION_JUMP,
  MIN_FUNDING_POOL_REVOCATION_JUMP,
  MIN_RANDOM_FUNDING_POOL_REVOCATION_JUMP,
  fundingPoolDrawRevocationTypes,
  getFundingPoolDrawRevocationHash,
  getRandomFundingPoolRevocationNonce,
} from "./messages/v2.4/funding-pool"
import {
  TransferConsent,
  getTransferConsentMessage,
  getTransferExecutionId,
} from "./messages/v2.3/transfer-consent"
import {
  HubPermit,
  hubPermitTypes,
  getHubPermitTypedData,
  getHubPermitHash,
  splitHubPermitSignature,
} from "./messages/v2.3/hub-permit"

import {
  GenericMappingDeleteEntry,
  GenericMappingSetEntry,
  genericMappingDeleteEntryTypes,
  genericMappingSetEntryTypes,
  getGenericMappingDeleteEntryHash,
  getGenericMappingSetEntryHash,
} from "./messages/v2.4/generic-mapping"

import {
  WithdrawRequestAuthorization,
  WithdrawRequestAuthorizationMessage,
  withdrawRequestAuthorizationTypes,
  getWithdrawRequestAuthorizationHash,
  getWithdrawRequestAuthorizationTypedData,
} from "./messages/v2.4/withdraw-request-authorization"

import {
  OracleExecution,
  OracleExecutionMessage,
  getOracleExecutionHash,
  oracleExecutionTypes,
} from "./messages/v2.4/execution"

import {
  VmType,
  decodeAddress,
  decodeXrpDestination,
  encodeAddress,
  encodeAddressToHex,
  encodeBytes,
  getVmTypeNativeCurrency,
} from "./utils"

import {
  HEDERA_HBAR_TOKEN_ID,
  HEDERA_LEDGER_IDS,
  HEDERA_MAINNET_USDC_TOKEN_ID,
  HEDERA_TRANSACTION_HASH_BYTE_LENGTH,
  HederaAddress,
  HederaEntityId,
  HederaEntityIdParseOptions,
  HederaNetwork,
  HederaTimestamp,
  HederaTransactionId,
  HederaTransactionReference,
  decodeHederaAddress,
  encodeHederaAddress,
  evmAddressToHederaEntityId,
  formatHederaAddress,
  formatHederaEntityId,
  formatHederaEntityIdWithChecksum,
  formatHederaTimestamp,
  formatHederaTransactionId,
  getHederaEntityIdChecksum,
  hederaEntityIdToEvmAddress,
  normalizeHederaTransactionReference,
  parseHederaAddress,
  parseHederaEntityId,
  parseHederaTimestamp,
  parseHederaTransactionHash,
  parseHederaTransactionId,
  toHederaMirrorNodeTransactionId,
} from "./hedera-vm"

import {
  LIGHTER_ACCOUNT_INDEX_MAX,
  formatLighterAccountIndex,
  parseLighterAccountIndex,
} from "./lighter-vm"

import {
  ATLAS_ASSET_ID_MAX,
  formatAtlasAssetId,
  parseAtlasAssetId,
} from "./atlas-vm"

import {
  TokenIdComponents,
  VirtualAddressComponents,
  TokenId,
  VirtualAddress,
  generateAddress,
  generateTokenId,
} from "./hub/hub-utils"

import type {
  NetworkConfig,
  NetworkConfigs,
  ProtocolContracts,
} from "./networks"

export {
  // Order
  Order,
  OrderV2,
  encodeOrderCall,
  decodeOrderCall,
  encodeOrderExtraData,
  decodeOrderExtraData,
  getOrderId,
  getOrderV2Id,

  // Routed calls (ethereum-vm)
  RoutedCall,
  RoutedWithdrawalData,
  ROUTED_WITHDRAWAL_DATA_VERSION,
  encodeRoutedCallsCalldata,
  hashRoutedCalls,
  multicallRouterAbi,
  CallRequestWithdrawal,
  CommittedCallRequestWithdrawal,
  toExecutableCallRequest,
  encodeRoutedWithdrawalData,
  decodeRoutedWithdrawalData,

  // Routed transfers and relay-router bundles (solana-vm)
  ROUTED_TRANSFER_REQUEST_PREFIX,
  SolanaRoutedTransferRequest,
  decodeSolanaRoutedTransferRequest,
  encodeSolanaRoutedTransferRequest,
  getSolanaRoutedTransferRequestHash,
  getSolanaUsedRequestAddress,
  SOLANA_NATIVE_MINT,
  SOLANA_ROUTED_WITHDRAWAL_DATA_VERSION,
  SOLANA_ROUTER_BUNDLE_VERSION,
  SolanaBundleCall,
  SolanaCallAccount,
  SolanaRoutedWithdrawalData,
  SolanaRouterBundle,
  decodeSolanaRoutedWithdrawalData,
  decodeSolanaRouterBundle,
  encodeSolanaRoutedWithdrawalData,
  encodeSolanaRouterBundle,
  encodeSolanaRouterReleaseData,
  encodeSolanaRouterSettleData,
  getSolanaRouterAuthority,
  getSolanaRouterConfigAddress,
  getSolanaRouterDepositoryRole,
  encodeSolanaRouterInitializeData,
  encodeSolanaRouterGrantDepositoryRoleData,
  encodeSolanaRouterRevokeDepositoryRoleData,
  encodeSolanaRouterSetOwnerData,
  getSolanaRouterBundleAddress,
  getSolanaRouterBundleHash,
  getSolanaRouterBundlePda,
  toSolanaBundleFillMint,
  toSolanaBundleWithdrawMint,
  RelayRouterIdl,

  // Utils
  VmType,
  decodeAddress,
  decodeXrpDestination,
  encodeAddress,
  encodeAddressToHex,
  encodeBytes,
  getVmTypeNativeCurrency,

  // Hedera identities (accounts, HTS tokens, transactions)
  HEDERA_HBAR_TOKEN_ID,
  HEDERA_LEDGER_IDS,
  HEDERA_MAINNET_USDC_TOKEN_ID,
  HEDERA_TRANSACTION_HASH_BYTE_LENGTH,
  HederaAddress,
  HederaEntityId,
  HederaEntityIdParseOptions,
  HederaNetwork,
  HederaTimestamp,
  HederaTransactionId,
  HederaTransactionReference,
  decodeHederaAddress,
  encodeHederaAddress,
  evmAddressToHederaEntityId,
  formatHederaAddress,
  formatHederaEntityId,
  formatHederaEntityIdWithChecksum,
  formatHederaTimestamp,
  formatHederaTransactionId,
  getHederaEntityIdChecksum,
  hederaEntityIdToEvmAddress,
  normalizeHederaTransactionReference,
  parseHederaAddress,
  parseHederaEntityId,
  parseHederaTimestamp,
  parseHederaTransactionHash,
  parseHederaTransactionId,
  toHederaMirrorNodeTransactionId,

  // Lighter identity codec
  LIGHTER_ACCOUNT_INDEX_MAX,
  formatLighterAccountIndex,
  parseLighterAccountIndex,

  // Atlas asset id codec
  ATLAS_ASSET_ID_MAX,
  formatAtlasAssetId,
  parseAtlasAssetId,

  // Messages v2.1

  // DepositoryDeposit
  DepositoryDepositMessage,

  // DepositoryWithdrawal
  DecodedBitcoinVmWithdrawal,
  DecodedEthereumVmWithdrawal,
  DecodedGatewayVmWithdrawal,
  GatewayBurnIntent,
  decodeGatewaySolanaVmTransferRequest,
  encodeGatewaySolanaVmTransferRequest,
  GATEWAY_ROUTED_TRANSFER_REQUEST_PREFIX,
  GATEWAY_TRANSFER_REQUEST_PREFIX,
  GatewaySolanaVmTransferRequest,
  getGatewaySolanaVmTransferRequestHash,
  SOLANA_VM_GATEWAY_MINTER,
  GatewayTransferSpec,
  GatewayVmWithdrawal,
  getGatewayDestinationExpiration,
  getGatewayDestinationVmType,
  DecodedSolanaVmWithdrawal,
  DecodedHederaVmWithdrawal,
  DecodedHyperliquidVmWithdrawal,
  AtlasTransferParams,
  DecodedAtlasVmWithdrawal,
  DecodedLighterVmWithdrawal,
  DecodedTonVmWithdrawal,
  DecodedTronVmWithdrawal,
  DecodedXrpVmWithdrawal,
  DecodedWithdrawal,
  LighterTransferParams,
  PendingWithdrawalVmType,
  WithdrawalVmType,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  encodeWithdrawal,
  decodeWithdrawal,
  getDecodedWithdrawalId,
  buildLighterTransferL1Message,
  getHederaVmTransactionBody,

  // SolverRefund
  SolverRefundMessage,
  SolverRefundStatus,

  // SolverFill
  SolverFillMessage,
  SolverFillStatus,

  // Messages v2.2

  // Execution
  ExecutionMessage,
  ExecutionMessageMetadata,
  ActionType,
  encodeAction,
  decodeAction,

  // Generic mapping
  GenericMappingMessage,
  getNoFillOrRefundMessage,
  getNonceMappingMessage,
  getWithdrawParamsMappingMessage,
  getGenericMappingMessageId,

  // Withdrawal
  OrderAddressParams,
  getOrderAddress,

  // Messages v2.3

  // Deposit address
  DepositAddressTrigger,
  DepositAddressTriggerCurrency,
  DepositAddressTriggerDerivationFields,
  DepositAddressTriggerInput,
  DepositAddressTriggerPrice,
  getDepositAddressTriggerHash,

  // Withdrawal
  WithdrawRequest,
  BitcoinVmWithdrawRequestAdditionalData,
  EthereumVmWithdrawRequestAdditionalData,
  GatewayVmWithdrawRequestAdditionalData,
  SolanaVmWithdrawRequestAdditionalData,
  WithdrawRequestAdditionalData,
  DenormalizedWithdrawRequest,
  ExecuteAndWithdrawFee,
  ExecuteAndWithdrawRequest,
  executeAndWithdrawRequestTypes,
  getExecuteAndWithdrawRequestHash,
  computeExecutionId,
  getWithdrawRequestHash,
  encodeWithdrawRequestAdditionalData,
  normalizeWithdrawRequest,

  // Funding pools
  DrawLeg,
  DrawLegKind,
  FundingPoolDrawAuthorization,
  FundingPoolDrawConfig,
  FundingPoolDrawConfigUpdate,
  FundingPoolDrawResolverUpdate,
  FundingPoolDrawRevocation,
  FundingPoolWithdrawal,
  PoolDrawResolverExecution,
  PoolResolverCall,
  fundingPoolDrawAuthorizationTypes,
  fundingPoolDrawConfigUpdateTypes,
  fundingPoolDrawResolverUpdateTypes,
  fundingPoolDrawRevocationTypes,
  fundingPoolWithdrawalTypes,
  encodeFundingPoolDrawAuthorization,
  getFundingPoolDrawAuthorizationHash,
  getFundingPoolDrawConfigUpdateHash,
  getFundingPoolDrawResolverUpdateHash,
  getFundingPoolDrawRevocationHash,
  getRandomFundingPoolRevocationNonce,
  MIN_FUNDING_POOL_REVOCATION_JUMP,
  MIN_RANDOM_FUNDING_POOL_REVOCATION_JUMP,
  MAX_FUNDING_POOL_REVOCATION_JUMP,
  getFundingPoolWithdrawalHash,
  getPoolDrawResolverCommitmentNonce,
  getPoolDrawResolverPlanHash,
  encodePoolDrawResolverExecution,
  encodePoolDrawResolverData,
  decodePoolDrawResolverData,
  decodePoolDrawResolverExecution,
  TransferConsent,
  HubPermit,
  getTransferConsentMessage,
  getTransferExecutionId,
  hubPermitTypes,
  getHubPermitTypedData,
  getHubPermitHash,
  splitHubPermitSignature,

  // Messages v2.4

  // Generic mapping
  GenericMappingDeleteEntry,
  GenericMappingSetEntry,
  genericMappingDeleteEntryTypes,
  genericMappingSetEntryTypes,
  getGenericMappingDeleteEntryHash,
  getGenericMappingSetEntryHash,

  // Withdraw authorization
  WithdrawRequestAuthorization,
  WithdrawRequestAuthorizationMessage,
  withdrawRequestAuthorizationTypes,
  getWithdrawRequestAuthorizationHash,
  getWithdrawRequestAuthorizationTypedData,

  // Oracle execution
  OracleExecution,
  OracleExecutionMessage,
  getOracleExecutionHash,
  oracleExecutionTypes,

  // Misc

  // Hub utils
  TokenIdComponents,
  VirtualAddressComponents,
  TokenId,
  VirtualAddress,
  generateAddress,
  generateTokenId,

  // Networks
  NetworkConfigs,
  ProtocolContracts,
  NetworkConfig,
}

// Separate-payer fees for v2.4 allocators.
export {
  WithdrawFeePayment,
  WithdrawFeePaymentAuthorization,
  withdrawFeePaymentAuthorizationTypes,
  getWithdrawFeePaymentAuthorizationHash,
} from "./messages/v2.4/withdrawal"

export { Authorization } from "./messages/v2.4/authorization"
