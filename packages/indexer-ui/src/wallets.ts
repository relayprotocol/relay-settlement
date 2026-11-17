import { useQuery } from "@tanstack/react-query"
import { allocatorQueries, hubQueries } from "./api/queries"
import type { Suspension } from "./api/schema"
import type { Prefetch } from "./prefetch"
import { heldRoles } from "./roles"

export const isSuspended = (suspensions: Suspension[], address: string) =>
  suspensions.some(
    (suspension) =>
      suspension.suspended &&
      suspension.alias.toLowerCase() === address.toLowerCase()
  )

const walletTransfers = (address: string) =>
  hubQueries.transfers({ account: address.toLowerCase() })

export const prefetchWallet =
  (address: string): Prefetch =>
  (queryClient) => [
    queryClient.query(hubQueries.walletBalances(address)),
    queryClient.query(walletTransfers(address)),
    queryClient.query(hubQueries.state()),
    queryClient.query(allocatorQueries.suspensions()),
  ]

export const useEmptyWallet = (address: string) => {
  const cached = { enabled: false, placeholderData: undefined }
  const balances = useQuery({
    ...hubQueries.walletBalances(address),
    ...cached,
  }).data
  const transfers = useQuery({ ...walletTransfers(address), ...cached }).data
  const state = useQuery({ ...hubQueries.state(), enabled: false }).data
  const suspensions = useQuery({
    ...allocatorQueries.suspensions(),
    enabled: false,
  }).data
  return (
    balances?.balances.length === 0 &&
    transfers?.transfers.length === 0 &&
    state !== undefined &&
    heldRoles(state.state?.snapshot?.configuration.roles ?? [], address)
      .length === 0 &&
    suspensions !== undefined &&
    !isSuspended(suspensions.suspensions, address)
  )
}
