import type {
  DepositoryState,
  FacadeConfigView,
  ResolvedPrice,
} from "./api/schema"
import { usdValue } from "./utils"

type AssetValue = { state: DepositoryState; value?: number }

export const balanceOf = (state: DepositoryState) => state.snapshot?.balance

export const decimalsOf = (state: DepositoryState) =>
  state.snapshot?.decimals ?? state.target.decimals

export const assetId = (
  state: DepositoryState,
  facades: FacadeConfigView[] = []
) => {
  const asset = state.target.origin_asset?.toLowerCase()
  const facade = facades.find(
    (facade) => facade.address === asset || facade.target === asset
  )
  return facade?.target ?? state.target.origin_asset ?? state.token_id
}

export const usdPrice = (resolved?: ResolvedPrice | null) => {
  const price = resolved?.price
  return price?.status === "available" || price?.status === "stale"
    ? (price.usd_price ?? undefined)
    : undefined
}

export const assetValues = (
  states: DepositoryState[],
  priceOf: (tokenId: string) => string | undefined,
  facades: FacadeConfigView[] = []
) => {
  const assets = new Map<string, AssetValue>()
  for (const state of states) {
    const price = priceOf(state.token_id)
    const balance = balanceOf(state)
    const value =
      price && balance ? usdValue(balance, decimalsOf(state), price) : undefined
    const id = assetId(state, facades)
    const current = assets.get(id)
    if (!current || (current.value == null && value != null))
      assets.set(id, { state, value })
  }
  const values = [...assets.values()].flatMap(({ value }) =>
    value == null ? [] : [value]
  )
  const total = values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : null
  return { assets, total }
}
