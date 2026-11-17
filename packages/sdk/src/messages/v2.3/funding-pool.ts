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
  // Committed recipient of unused input and output above the signed minimum.
  // Both may be zero only for a plan without draw legs (basic resolution).
  surplusPool: Address
  surplusAccount: Address
  salt: Hex
}

// Mirrors `IFundingPool.DrawConfig`. A zero `authorizer` closes
// the token for draws
export type FundingPoolDrawConfig = {
  perOrderCap: bigint
  budget: bigint
  authorizer: Address
  expiry: bigint
}

// Mirrors `IFundingPool.DrawAuthorization`. `planHash` is
// `getPoolDrawResolverPlanHash(executionData)` for the committed plan the
// authorization funds; `nonce` is the pool's `drawNonces(account)` at
// signing time (any config or allowlist change moves it and voids every
// outstanding authorization); `deadline` is inclusive, and zero is always
// expired
export type FundingPoolDrawAuthorization = {
  account: Address
  orderAddress: Address
  planHash: Hex
  nonce: bigint
  deadline: bigint
}

// Mirrors `IFundingPool.PoolWithdrawal`
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

// Mirrors `FundingPool.hashWithdrawal`
export const getFundingPoolWithdrawalHash = (
  chainId: number,
  pool: Address,
  withdrawal: FundingPoolWithdrawal
) =>
  hashTypedData({
    domain: {
      name: "FundingPool",
      version: "1",
      chainId,
      verifyingContract: pool,
    },
    types: fundingPoolWithdrawalTypes,
    primaryType: "PoolWithdrawal",
    message: withdrawal,
  })

// Mirrors `IFundingPool.DrawConfigUpdate`
export type FundingPoolDrawConfigUpdate = {
  account: Address
  token: Address
  authorizer: Address
  perOrderCap: bigint
  budget: bigint
  expiry: bigint
  epoch: bigint
  nonce: bigint
  deadline: bigint
}

// Mirrors `IFundingPool.DrawResolverUpdate`
export type FundingPoolDrawResolverUpdate = {
  account: Address
  resolver: Address
  allowed: boolean
  epoch: bigint
  nonce: bigint
  deadline: bigint
}

// The primary type stays "DrawConfigUpdate" — the on-chain
// `DRAW_CONFIG_UPDATE_TYPEHASH` is derived from the Solidity struct name
export const fundingPoolDrawConfigUpdateTypes = {
  DrawConfigUpdate: [
    { name: "account", type: "address" },
    { name: "token", type: "address" },
    { name: "authorizer", type: "address" },
    { name: "perOrderCap", type: "uint256" },
    { name: "budget", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "epoch", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

// Mirrors `FundingPool.hashDrawConfigUpdate`
export const getFundingPoolDrawConfigUpdateHash = (
  chainId: number,
  pool: Address,
  update: FundingPoolDrawConfigUpdate
) =>
  hashTypedData({
    domain: {
      name: "FundingPool",
      version: "1",
      chainId,
      verifyingContract: pool,
    },
    types: fundingPoolDrawConfigUpdateTypes,
    primaryType: "DrawConfigUpdate",
    message: update,
  })

// The primary type stays "DrawResolverUpdate" — the on-chain
// `DRAW_RESOLVER_UPDATE_TYPEHASH` is derived from the Solidity struct name
export const fundingPoolDrawResolverUpdateTypes = {
  DrawResolverUpdate: [
    { name: "account", type: "address" },
    { name: "resolver", type: "address" },
    { name: "allowed", type: "bool" },
    { name: "epoch", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

// Mirrors `FundingPool.hashDrawResolverUpdate`
export const getFundingPoolDrawResolverUpdateHash = (
  chainId: number,
  pool: Address,
  update: FundingPoolDrawResolverUpdate
) =>
  hashTypedData({
    domain: {
      name: "FundingPool",
      version: "1",
      chainId,
      verifyingContract: pool,
    },
    types: fundingPoolDrawResolverUpdateTypes,
    primaryType: "DrawResolverUpdate",
    message: update,
  })

// Sign only the current on-chain epoch; a revocation invalidates queued updates.
export type FundingPoolDrawRevocation = {
  account: Address
  epoch: bigint
  deadline: bigint
}

export const fundingPoolDrawRevocationTypes = {
  DrawRevocation: [
    { name: "account", type: "address" },
    { name: "epoch", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

export const getFundingPoolDrawRevocationHash = (
  chainId: number,
  pool: Address,
  revocation: FundingPoolDrawRevocation
) =>
  hashTypedData({
    domain: {
      name: "FundingPool",
      version: "1",
      chainId,
      verifyingContract: pool,
    },
    types: fundingPoolDrawRevocationTypes,
    primaryType: "DrawRevocation",
    message: revocation,
  })

// The primary type stays "DrawAuthorization" — the on-chain
// `DRAW_AUTHORIZATION_TYPEHASH` is derived from the Solidity struct name
export const fundingPoolDrawAuthorizationTypes = {
  DrawAuthorization: [
    { name: "account", type: "address" },
    { name: "orderAddress", type: "address" },
    { name: "planHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

// Mirrors `FundingPool.hashDrawAuthorization` — the statement an
// account's authorizer signs so the pool will fund one order through one
// exact plan. Scoped to the account, the order and the plan hash; replay
// inside the order is bounded by the pool's per-order draw records and cap,
// and the nonce and deadline bound the signature's lifetime
export const getFundingPoolDrawAuthorizationHash = (
  chainId: number,
  pool: Address,
  authorization: FundingPoolDrawAuthorization
) =>
  hashTypedData({
    domain: {
      name: "FundingPool",
      version: "1",
      chainId,
      verifyingContract: pool,
    },
    types: fundingPoolDrawAuthorizationTypes,
    primaryType: "DrawAuthorization",
    message: authorization,
  })

// The `abi.encode(DrawAuthorization, bytes signature)` envelope the pool
// decodes from each leg's authorization slot in `encodePoolDrawResolverData`.
// The signature is EIP-712 over `getFundingPoolDrawAuthorizationHash` (EOA or
// ERC-1271). Legs naming the same pool and account can share one envelope
export const encodeFundingPoolDrawAuthorization = (
  authorization: FundingPoolDrawAuthorization,
  signature: Hex
): Hex =>
  encodeAbiParameters(
    [
      {
        name: "authorization",
        type: "tuple",
        components: fundingPoolDrawAuthorizationTypes.DrawAuthorization,
      },
      { name: "signature", type: "bytes" },
    ],
    [authorization, signature]
  )

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
      { name: "surplusPool", type: "address" },
      { name: "surplusAccount", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
  },
] as const

export const encodePoolDrawResolverExecution = (
  execution: PoolDrawResolverExecution
): Hex => encodeAbiParameters(poolDrawResolverExecutionAbi, [execution])

// Mirrors `keccak256(executionData)` in `PoolDrawResolver.execute` — the plan
// hash every draw authorization must sign. Pass the encoded execution plan
// (`encodePoolDrawResolverExecution`): the same bytes
// `getPoolDrawResolverCommitmentNonce` commits to the oracle
export const getPoolDrawResolverPlanHash = (executionData: Hex): Hex =>
  keccak256(executionData)

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
    surplusPool: execution.surplusPool,
    surplusAccount: execution.surplusAccount,
    salt: execution.salt,
  }
}

const poolDrawResolverDataAbi = [
  { name: "executionData", type: "bytes" },
  { name: "authorizations", type: "bytes[]" },
] as const

// Assembles the full `callResolverData` the resolver decodes:
// `abi.encode(bytes executionData, bytes[] authorizations)`. The execution is
// the committed half (its bytes are what the commitment nonce and the plan
// hash cover); the authorizations are one `encodeFundingPoolDrawAuthorization`
// envelope per leg, parallel by index — legs naming the same pool and account
// repeat the same bytes — and ride outside the commitment so they can be
// signed after the plan is attested, once the order address is known. The
// pool verifies each one against the account's configured authorizer and the
// plan the resolver is executing; tampering fails closed on-chain
export const encodePoolDrawResolverData = (
  executionData: Hex,
  authorizations: Hex[]
): Hex =>
  encodeAbiParameters(poolDrawResolverDataAbi, [executionData, authorizations])

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
