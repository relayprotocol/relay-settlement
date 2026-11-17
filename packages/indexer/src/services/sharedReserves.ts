import { ZeroAddress } from "ethers"

/**
 * Hub tokens whose origin currencies are two representations of ONE physical
 * depository balance: a chain's native asset and an ERC-20 facade over the
 * same balance. Spending either moves the same coins, so each token checked
 * alone against the depository balance can read as covered while their
 * combined supply exceeds it. The audit sums every group's supply instead.
 *
 * To add a group: confirm on-chain that the facade's `balanceOf(account)`
 * equals the account's native balance and that its `transfer()` moves it (a
 * 1:1 wrapper with its own supply, such as WETH, does not belong here).
 */
export type SharedReserveGroup = {
  /**
   * Currencies (origin assets) that read and spend the same balance, with
   * their on-chain decimals. The combined check uses these decimals rather
   * than the indexed token metadata, which can be missing or defaulted.
   */
  members: Array<{ currency: string; decimals: number }>
  /** Label used in audit results and logs. */
  name: string
  /** Hub token metadata `originChainId` of every member. */
  originChainId: string
}

export const SHARED_RESERVE_GROUPS: SharedReserveGroup[] = [
  // Native USDC (18 decimals) and the USDC ERC-20 interface (6 decimals).
  {
    members: [
      { currency: ZeroAddress, decimals: 18 },
      { currency: "0x3600000000000000000000000000000000000000", decimals: 6 },
    ],
    name: "arc-usdc",
    originChainId: "5042",
  },
  // Native USDT0 (18 decimals) and the USDT0 ERC-20 (6 decimals).
  {
    members: [
      { currency: ZeroAddress, decimals: 18 },
      { currency: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6 },
    ],
    name: "stable-usdt0",
    originChainId: "988",
  },
  // Native CELO and the CELO token, which moves the native balance.
  {
    members: [
      { currency: ZeroAddress, decimals: 18 },
      { currency: "0x471EcE3750Da237f93B8E339c536989b8978a438", decimals: 18 },
    ],
    name: "celo-celo",
    originChainId: "42220",
  },
  // Native METIS and the legacy METIS ERC-20 over the native balance.
  {
    members: [
      { currency: ZeroAddress, decimals: 18 },
      { currency: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000", decimals: 18 },
    ],
    name: "metis-metis",
    originChainId: "1088",
  },
]

export const findSharedReserveMember = (
  group: SharedReserveGroup,
  currency: string | null
) =>
  currency == null
    ? undefined
    : group.members.find(
        (member) => member.currency.toLowerCase() === currency.toLowerCase()
      )

export const findSharedReserveGroup = (
  originChainId: string | null,
  currency: string | null,
  groups: SharedReserveGroup[] = SHARED_RESERVE_GROUPS
) =>
  originChainId == null
    ? undefined
    : groups.find(
        (group) =>
          group.originChainId === originChainId &&
          findSharedReserveMember(group, currency)
      )
