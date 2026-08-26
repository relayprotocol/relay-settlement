import {
  Address,
  Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  hashTypedData,
  keccak256,
} from "viem"

// Mirrors `ResolverSandbox.Call`
export type PoolResolverCall = {
  to: Address
  data: Hex
}

// Mirrors `PoolResolverBase.DrawLegKind`
export enum DrawLegKind {
  FIXED = 0,
  SHORTFALL_TO_TARGET = 1,
}

// Mirrors `PoolResolverBase.DrawLeg`. The per-order draw authorization is not
// part of the leg: it travels beside the committed execution payload (see
// `encodePoolDrawResolverData`), so it can be signed after the plan is
// attested, once the order address is known
export type DrawLeg = {
  pool: Address
  account: Address
  kind: DrawLegKind
  tokenIn: Address
  tokenOut: Address
  amount: bigint
  amountOutMinimum: bigint
  calls: PoolResolverCall[]
}

// Mirrors `PoolDrawResolver.Execution` — the committed half of the resolver
// payload. `salt` is per-order entropy: the oracle-signed request nonce is
// derived from this plan (see `getPoolDrawResolverCommitmentNonce`) and the
// allocator requires that nonce to be unique per order, so identical plans
// across orders must differ here
export type PoolDrawResolverExecution = {
  legs: DrawLeg[]
  calls: PoolResolverCall[]
  salt: Hex
}

// Mirrors `IRelayFundingPool.SponsorshipConfig`. A zero `authorizer` closes
// the token for draws
export type FundingPoolSponsorshipConfig = {
  perOrderCap: bigint
  budget: bigint
  authorizer: Address
  expiry: bigint
}

// Mirrors `IRelayFundingPool.DrawAuthorization`
export type FundingPoolDrawAuthorization = {
  account: Address
  orderAddress: Address
}

// Mirrors `IRelayFundingPool.PoolWithdrawal`
export type FundingPoolWithdrawal = {
  account: Address
  token: Address
  amount: bigint
  recipient: Address
  nonce: bigint
  deadline: bigint
}

// The primary type stays "PoolWithdrawal" — the on-chain
// `POOL_WITHDRAWAL_TYPEHASH` is derived from the Solidity struct name
export const fundingPoolWithdrawalTypes = {
  PoolWithdrawal: [
    { name: "account", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

// Mirrors `RelayFundingPool.hashWithdrawal`
export const getFundingPoolWithdrawalHash = (
  chainId: number,
  pool: Address,
  withdrawal: FundingPoolWithdrawal
) =>
  hashTypedData({
    domain: {
      name: "RelayFundingPool",
      version: "1",
      chainId,
      verifyingContract: pool,
    },
    types: fundingPoolWithdrawalTypes,
    primaryType: "PoolWithdrawal",
    message: withdrawal,
  })

// Mirrors `IRelayFundingPool.SponsorshipConfigUpdate`
export type FundingPoolSponsorshipConfigUpdate = {
  account: Address
  token: Address
  authorizer: Address
  perOrderCap: bigint
  budget: bigint
  expiry: bigint
  nonce: bigint
  deadline: bigint
}

// Mirrors `IRelayFundingPool.SponsorshipResolverUpdate`
export type FundingPoolSponsorshipResolverUpdate = {
  account: Address
  resolver: Address
  allowed: boolean
  nonce: bigint
  deadline: bigint
}

// The primary type stays "SponsorshipConfigUpdate" — the on-chain
// `SPONSORSHIP_CONFIG_UPDATE_TYPEHASH` is derived from the Solidity struct name
export const fundingPoolSponsorshipConfigUpdateTypes = {
  SponsorshipConfigUpdate: [
    { name: "account", type: "address" },
    { name: "token", type: "address" },
    { name: "authorizer", type: "address" },
    { name: "perOrderCap", type: "uint256" },
    { name: "budget", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

// Mirrors `RelayFundingPool.hashSponsorshipConfigUpdate`
export const getFundingPoolSponsorshipConfigUpdateHash = (
  chainId: number,
  pool: Address,
  update: FundingPoolSponsorshipConfigUpdate
) =>
  hashTypedData({
    domain: {
      name: "RelayFundingPool",
      version: "1",
      chainId,
      verifyingContract: pool,
    },
    types: fundingPoolSponsorshipConfigUpdateTypes,
    primaryType: "SponsorshipConfigUpdate",
    message: update,
  })

// The primary type stays "SponsorshipResolverUpdate" — the on-chain
// `SPONSORSHIP_RESOLVER_UPDATE_TYPEHASH` is derived from the Solidity struct name
export const fundingPoolSponsorshipResolverUpdateTypes = {
  SponsorshipResolverUpdate: [
    { name: "account", type: "address" },
    { name: "resolver", type: "address" },
    { name: "allowed", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

// Mirrors `RelayFundingPool.hashSponsorshipResolverUpdate`
export const getFundingPoolSponsorshipResolverUpdateHash = (
  chainId: number,
  pool: Address,
  update: FundingPoolSponsorshipResolverUpdate
) =>
  hashTypedData({
    domain: {
      name: "RelayFundingPool",
      version: "1",
      chainId,
      verifyingContract: pool,
    },
    types: fundingPoolSponsorshipResolverUpdateTypes,
    primaryType: "SponsorshipResolverUpdate",
    message: update,
  })

// The primary type stays "DrawAuthorization" — the on-chain
// `DRAW_AUTHORIZATION_TYPEHASH` is derived from the Solidity struct name
export const fundingPoolDrawAuthorizationTypes = {
  DrawAuthorization: [
    { name: "account", type: "address" },
    { name: "orderAddress", type: "address" },
  ],
} as const

// Mirrors `RelayFundingPool.hashDrawAuthorization` — the per-order statement
// that an account's authorizer signs so the pool will fund that order. Scoped
// to one account and one order; replay inside the order is bounded by the
// pool's per-order draw records and cap
export const getFundingPoolDrawAuthorizationHash = (
  chainId: number,
  pool: Address,
  authorization: FundingPoolDrawAuthorization
) =>
  hashTypedData({
    domain: {
      name: "RelayFundingPool",
      version: "1",
      chainId,
      verifyingContract: pool,
    },
    types: fundingPoolDrawAuthorizationTypes,
    primaryType: "DrawAuthorization",
    message: authorization,
  })

const callComponents = [
  { name: "to", type: "address" },
  { name: "data", type: "bytes" },
] as const

const drawLegComponents = [
  { name: "pool", type: "address" },
  { name: "account", type: "address" },
  { name: "kind", type: "uint8" },
  { name: "tokenIn", type: "address" },
  { name: "tokenOut", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "amountOutMinimum", type: "uint256" },
  { name: "calls", type: "tuple[]", components: callComponents },
] as const

const poolDrawResolverExecutionAbi = [
  {
    name: "execution",
    type: "tuple",
    components: [
      { name: "legs", type: "tuple[]", components: drawLegComponents },
      { name: "calls", type: "tuple[]", components: callComponents },
      { name: "salt", type: "bytes32" },
    ],
  },
] as const

export const encodePoolDrawResolverExecution = (
  execution: PoolDrawResolverExecution
): Hex => encodeAbiParameters(poolDrawResolverExecutionAbi, [execution])

export const decodePoolDrawResolverExecution = (
  data: Hex
): PoolDrawResolverExecution => {
  const [execution] = decodeAbiParameters(poolDrawResolverExecutionAbi, data)
  return {
    legs: execution.legs.map((leg) => ({
      pool: leg.pool,
      account: leg.account,
      kind: leg.kind as DrawLegKind,
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
      amount: leg.amount,
      amountOutMinimum: leg.amountOutMinimum,
      calls: leg.calls.map((call) => ({ to: call.to, data: call.data })),
    })),
    calls: execution.calls.map((call) => ({ to: call.to, data: call.data })),
    salt: execution.salt,
  }
}

const poolDrawResolverDataAbi = [
  { name: "executionData", type: "bytes" },
  { name: "authorizations", type: "bytes[]" },
] as const

// Assembles the full `callResolverData` the resolver decodes:
// `abi.encode(bytes executionData, bytes[] authorizations)`. The execution is
// the committed half (its bytes are what the commitment nonce hashes); the
// authorizations are one per leg, parallel by index — legs naming the same
// account repeat the same bytes — and ride outside the commitment so they can
// be signed after the plan is attested. The pool verifies each one against
// the account's configured authorizer; tampering fails closed on-chain
export const encodePoolDrawResolverData = (
  executionData: Hex,
  authorizations: Hex[]
): Hex => encodeAbiParameters(poolDrawResolverDataAbi, [executionData, authorizations])

export const decodePoolDrawResolverData = (
  data: Hex
): { executionData: Hex; authorizations: Hex[] } => {
  const [executionData, authorizations] = decodeAbiParameters(
    poolDrawResolverDataAbi,
    data
  )
  return { executionData, authorizations: [...authorizations] }
}

// Mirrors `PoolResolverBase._requirePayloadCommitment` — the nonce the oracle
// must sign into the `ExecuteAndWithdrawRequest` for a pool-privileged
// resolver to accept the payload:
// `keccak256(resolver ‖ keccak256(executionData))`. Pass the encoded
// execution plan (`encodePoolDrawResolverExecution`), not the full
// `callResolverData`: the draw authorizations are deliberately outside the
// commitment. The RelayExecutor's digest does not cover the resolver or its
// payload, so this commitment is what binds the oracle attestation to the
// exact draw legs; changing a byte of the plan (or the resolver address)
// requires a new attestation
export const getPoolDrawResolverCommitmentNonce = (
  resolver: Address,
  executionData: Hex
): Hex =>
  keccak256(
    encodePacked(["address", "bytes32"], [resolver, keccak256(executionData)])
  )
