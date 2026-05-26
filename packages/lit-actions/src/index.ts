import { VmType } from "@relay-protocol/settlement-sdk"

import { envs as allocatorEnvs } from "./allocator"
import { envs as depositAddressEnvs } from "./deposit-address"

export type AllocatorActionEnvironment = "dev" | "prod"
export type AllocatorActionVersion = "v1"

export interface AllocatorActionConfig {
  name: AllocatorActionEnvironment
  allocatorAddress: string
  hubEvmChainId: number
  allowedOracles: string[]
  oracleSignatureThreshold: number
}

export interface AllocatorAction {
  code: string
  config: AllocatorActionConfig
}

export function getAllocatorAction(
  environment: AllocatorActionEnvironment,
  version: AllocatorActionVersion,
  vmType: VmType
): AllocatorAction {
  const env = allocatorEnvs[environment]
  if (!env) {
    throw new Error(`missing environment ${environment}`)
  }
  const ver = env.versions[version]
  if (!ver) {
    throw new Error(`missing version ${version} for environment ${environment}`)
  }
  if (!ver.code[vmType]) {
    throw new Error(`missing vm-type ${vmType} for ${environment}/${version}`)
  }
  return {
    config: ver.config,
    code: ver.code[vmType],
  }
}

export type DepositAddressActionEnvironment = "dev"
export type DepositAddressActionVersion = "v1"

export interface DepositAddressActionConfig {
  name: DepositAddressActionEnvironment
  depositAddressManagerAddress: string
  hubEvmChainId: number
  allowedOracles: string[]
  oracleSignatureThreshold: number
}

export interface DepositAddressAction {
  code: string
  config: DepositAddressActionConfig
}

export function getDepositAddressAction(
  environment: DepositAddressActionEnvironment,
  version: DepositAddressActionVersion,
  vmType: VmType
): DepositAddressAction {
  const env = depositAddressEnvs[environment]
  if (!env) {
    throw new Error(`missing environment ${environment}`)
  }
  const ver = env.versions[version]
  if (!ver) {
    throw new Error(`missing version ${version} for environment ${environment}`)
  }
  if (!ver.code[vmType]) {
    throw new Error(`missing vm-type ${vmType} for ${environment}/${version}`)
  }
  return {
    config: ver.config,
    code: ver.code[vmType],
  }
}
