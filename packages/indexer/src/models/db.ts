export type TokenRow = {
  token_id: string
  name: string | null
  symbol?: string | null
  decimals: number | null
  origin_family: string | null
  origin_chain_id: string | null
  origin_asset: string | null
  total_supply: string
  holders: number
  transfers?: number
  updated_at: string
}

export type BalanceRow = {
  address: string
  token_id: string
  balance: string
}

export type EventRow = {
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

export type TransferStatRow = {
  bucket: string
  count: number
}

export type RoleEventRow = {
  contract_address: string
  block_number: number
  tx_hash: string
  log_index: number
  event_type: string
  role: string
  account: string | null
  sender: string | null
  previous_admin_role: string | null
  new_admin_role: string | null
  timestamp: number
}

export type RoleMemberRow = {
  contract_address: string
  role: string
  account: string
}

export type RoleAdminRow = {
  contract_address: string
  role: string
  admin_role: string
}

export type OracleExecutionRow = {
  tx_hash: string
  block_number: number
  log_index: number
  timestamp: number
  oracle_contract_address: string
  idempotency_key: string
  actions_json: string
  submitted_oracle_address: string | null
  aggregated_signature: string | null
}
