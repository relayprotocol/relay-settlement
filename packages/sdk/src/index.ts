import {
  Order,
  encodeOrderCall,
  decodeOrderCall,
  encodeOrderExtraData,
  decodeOrderExtraData,
  getOrderId,
} from "./order"

import {
  DepositoryDepositMessage,
  getDepositoryDepositMessageId,
} from "./messages/v2.1/depository-deposit"

import {
  DecodedBitcoinVmWithdrawal,
  DecodedEthereumVmWithdrawal,
  DecodedSolanaVmWithdrawal,
  DecodedSuiVmWithdrawal,
  DecodedHyperliquidVmWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDepositoryWithdrawalMessageId,
  encodeWithdrawal,
  decodeWithdrawal,
  getDecodedWithdrawalId,
  getDecodedWithdrawalCurrency,
  getDecodedWithdrawalAmount,
  getDecodedWithdrawalRecipient,
} from "./messages/v2.1/depository-withdrawal"

import {
  SolverRefundMessage,
  SolverRefundStatus,
  getSolverRefundMessageId,
} from "./messages/v2.1/solver-refund"

import {
  SolverFillMessage,
  SolverFillStatus,
  getSolverFillMessageId,
} from "./messages/v2.1/solver-fill"

import {
  ActionType,
  ExecutionMessage,
  ExecutionMessageMetadata,
  getExecutionMessageId,
  encodeAction,
  decodeAction,
} from "./messages/v2.2/execution"

import {
  GenericMappingMessage,
  getGenericMappingMessageId,
  getNoFillOrRefundMessage,
  getNonceMappingMessage,
} from "./messages/v2.2/generic-mapping"

import {
  SubmitWithdrawRequest,
  DenormalizedSubmitWithdrawRequest,
  getSubmitWithdrawRequestHash,
  WithdrawalAddressParams,
  getWithdrawalAddress,
  WithdrawalAddressSafeParams,
  getWithdrawalAddressSafe,
  OrderAddressParams,
  getOrderAddress,
  getOrderAddressSafe,
  normalizePayloadParams,
} from "./messages/v2.2/withdrawal"

import {
  VmType,
  decodeAddress,
  decodeTransactionId,
  encodeAddress,
  encodeBytes,
  encodeTransactionId,
  getVmTypeNativeCurrency,
} from "./utils"

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
  encodeOrderCall,
  decodeOrderCall,
  encodeOrderExtraData,
  decodeOrderExtraData,
  getOrderId,

  // Utils
  VmType,
  decodeAddress,
  decodeTransactionId,
  encodeAddress,
  encodeBytes,
  encodeTransactionId,
  getVmTypeNativeCurrency,

  // Messages v2.1

  // DepositoryDeposit
  DepositoryDepositMessage,
  getDepositoryDepositMessageId,

  // DepositoryWithdrawal
  DecodedBitcoinVmWithdrawal,
  DecodedEthereumVmWithdrawal,
  DecodedSolanaVmWithdrawal,
  DecodedSuiVmWithdrawal,
  DecodedHyperliquidVmWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDepositoryWithdrawalMessageId,
  encodeWithdrawal,
  decodeWithdrawal,
  getDecodedWithdrawalId,
  getDecodedWithdrawalCurrency,
  getDecodedWithdrawalAmount,
  getDecodedWithdrawalRecipient,

  // SolverRefund
  SolverRefundMessage,
  SolverRefundStatus,
  getSolverRefundMessageId,

  // SolverFill
  SolverFillMessage,
  SolverFillStatus,
  getSolverFillMessageId,

  // Messages v2.2

  // Execution
  ExecutionMessage,
  ExecutionMessageMetadata,
  ActionType,
  getExecutionMessageId,
  encodeAction,
  decodeAction,

  // Generic mapping
  GenericMappingMessage,
  getNoFillOrRefundMessage,
  getNonceMappingMessage,
  getGenericMappingMessageId,

  // Withdrawal
  SubmitWithdrawRequest,
  DenormalizedSubmitWithdrawRequest,
  getSubmitWithdrawRequestHash,
  WithdrawalAddressParams,
  getWithdrawalAddress,
  WithdrawalAddressSafeParams,
  getWithdrawalAddressSafe,
  OrderAddressParams,
  getOrderAddress,
  getOrderAddressSafe,
  normalizePayloadParams,

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
