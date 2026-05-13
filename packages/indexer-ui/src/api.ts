export type Token = {
  token_id: string
  name: string | null
  symbol?: string | null
  decimals: number | null
  total_supply: string
  holders: number
  transfers: number
  updated_at: string
}

export type Balance = {
  address: string
  token_id: string
  balance: string
}

export type Holder = {
  address: string
  last_transfer_timestamp: number | null
}

export type Event = {
  block_number: number
  tx_hash: string
  log_index: number
  operator: string
  from_addr: string
  to_addr: string
  token_id: string
  amount: string
  timestamp: number
}

export type TransferStat = {
  bucket: string
  count: number
}

export type TransferStatsResponse = {
  granularity: string
  points: number
  data: TransferStat[]
}

export type RoleConfig = {
  role: string
  members: string[]
}

export type AppConfig = {
  authEnabled: boolean
  doBackgroundWork: boolean
  enableApi: boolean
  hubContractAddress?: string
  mode: string
  oracleContractAddress?: string
}

export type ApprovedOracleSummary = {
  address: string
  label: string | null
  signerCount: number
  threshold: number
  type: "contract" | "direct" | "multisig"
}

export type ApprovedOracleInstance = {
  address: string
  approvedOracle: ApprovedOracleSummary
  label: string | null
  type: "contract-role-member" | "direct-role-member" | "multisig-signer"
}

export type ApprovedOracle = ApprovedOracleSummary & {
  signers: ApprovedOracleInstance[]
}

export type ApprovedOracleInstancesResponse = {
  approvedOracles: ApprovedOracle[]
  count: number
  data: ApprovedOracleInstance[]
  oracleRole: string
  relayOracleAddress: string
  source: {
    fromBlock: number
    roleMembers: "indexed-role-members"
    verifiedAtBlock: number
  }
}

export type ProtocolTransfer = {
  logIndex: number
  operator: string
  from: string
  to: string
  tokenId: string
  amount: string
  type: "mint" | "transfer" | "burn"
}

export type ProtocolOracleExecution = {
  logIndex: number
  oracleContractAddress: string
  idempotencyKey: string
  actions: string[]
  submittedOracleAddress?: string
  aggregatedSignature?: string
}

export type ProtocolTransaction = {
  txHash: string
  blockNumber: number
  timestamp: string
  relayOperation: "mint" | "transfer" | "burn" | "mixed"
  transfers: ProtocolTransfer[]
  oracleExecutions: ProtocolOracleExecution[]
}

declare global {
  interface Window {
    __INDEXER_UI_CONFIG__?: {
      indexerApiUrl?: string
    }
  }
}

const apiBaseUrl = (
  window.__INDEXER_UI_CONFIG__?.indexerApiUrl ??
  import.meta.env.VITE_INDEXER_API_URL ??
  ""
).replace(/\/$/, "")

const withApiBaseUrl = (url: string) => {
  if (/^https?:\/\//i.test(url)) {
    return url
  }

  return `${apiBaseUrl}${url}`
}

const getJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(withApiBaseUrl(url), init)
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

export type CursorPage<T> = {
  data: T[]
  nextCursor: string | null
}

export const fetchTokens = (limit = 20, cursor?: string, query?: string) => {
  const params = new URLSearchParams()
  params.set("limit", String(limit))
  if (cursor) params.set("cursor", cursor)
  if (query) params.set("query", query)
  return getJson<CursorPage<Token>>(`/api/tokens?${params.toString()}`)
}

export const fetchToken = (tokenId: string) =>
  getJson<Token>(`/api/tokens/${tokenId}`)

export const fetchTokenBalances = (
  tokenId: string,
  limit = 100,
  cursor?: string
) => {
  const params = new URLSearchParams()
  params.set("limit", String(limit))
  if (cursor) params.set("cursor", cursor)
  return getJson<CursorPage<Balance>>(
    `/api/tokens/${tokenId}/balances?${params.toString()}`
  )
}

export const fetchTokenTransferStats = (
  tokenId: string,
  granularity = "day",
  points = 30,
  tzOffsetMinutes = 0
) =>
  getJson<TransferStatsResponse>(
    `/api/tokens/${tokenId}/transfer-stats?granularity=${granularity}&points=${points}&tzOffsetMinutes=${tzOffsetMinutes}`
  )

export const fetchGlobalTransferStats = (
  granularity = "day",
  points = 30,
  tzOffsetMinutes = 0
) =>
  getJson<TransferStatsResponse>(
    `/api/transfers/stats?granularity=${granularity}&points=${points}&tzOffsetMinutes=${tzOffsetMinutes}`
  )

export const fetchEvents = (
  tokenId?: string,
  address?: string,
  limit = 100,
  cursor?: string
) => {
  const params = new URLSearchParams()
  if (tokenId) params.set("tokenId", tokenId)
  if (address) params.set("address", address)
  params.set("limit", String(limit))
  if (cursor) params.set("cursor", cursor)
  return getJson<CursorPage<Event>>(`/api/events?${params.toString()}`)
}

export const fetchBalancesForAddress = (
  address: string,
  limit = 100,
  cursor?: string
) => {
  const params = new URLSearchParams()
  params.set("limit", String(limit))
  if (cursor) params.set("cursor", cursor)
  return getJson<CursorPage<{ token_id: string; balance: string }>>(
    `/api/balances/${address}?${params.toString()}`
  )
}

export const fetchHolders = (limit = 100, cursor?: string) => {
  const params = new URLSearchParams()
  params.set("limit", String(limit))
  if (cursor) params.set("cursor", cursor)
  return getJson<CursorPage<Holder>>(`/api/holders?${params.toString()}`)
}

export const fetchRoleConfig = (contractAddress: string) => {
  const params = new URLSearchParams()
  params.set("contract", contractAddress)
  return getJson<{ data: RoleConfig[] }>(`/api/roles?${params.toString()}`)
}

export const fetchConfig = () => getJson<AppConfig>("/api/config")

export const fetchApprovedOracles = () =>
  getJson<ApprovedOracleInstancesResponse>("/api/oracles/approved")

export const fetchProtocolTransactionsByHash = (txHashes: string[]) =>
  getJson<{ data: ProtocolTransaction[] }>(
    "/api/protocol/transactions/by-hash",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ txHashes }),
    }
  )
