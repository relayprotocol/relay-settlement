import { VmType } from "@relay-protocol/settlement-sdk"

import { allocatorEnvs, depositAddressEnvs } from "./generated"

export type {
  AllocatorActionEnvironment,
  AllocatorActionVersion,
  AllocatorActionConfig,
  AllocatorAction,
  DepositAddressActionEnvironment,
  DepositAddressActionVersion,
  DepositAddressActionConfig,
  DepositAddressAction,
} from "./types"

import type {
  AllocatorAction,
  AllocatorActionEnvironment,
  AllocatorActionVersion,
  DepositAddressAction,
  DepositAddressActionEnvironment,
  DepositAddressActionVersion,
} from "./types"

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
