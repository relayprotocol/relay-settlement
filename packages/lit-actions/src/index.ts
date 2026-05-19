import { VmType } from "@relay-protocol/settlement-sdk"

import { envs } from "./allocator"

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
  const env = envs[environment]
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
