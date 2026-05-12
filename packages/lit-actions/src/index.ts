import { VmType } from "@relay-protocol/settlement-sdk"

import * as allocatorV1 from "./allocator/v1"

export type AllocatorActionEnvironment = "dev"
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
  if (version === "v1") {
    const env = allocatorV1.envs[environment]
    if (!env) {
      throw new Error(`missing environment ${environment}`)
    }
    if (!env.code[vmType]) {
      throw new Error(`missing vm-type ${vmType} in environment ${environment}`)
    }

    return {
      config: env.config,
      code: env.code[vmType],
    }
  }

  throw new Error(
    `allocator action not found for ${version}/${environment}/${vmType}`
  )
}
