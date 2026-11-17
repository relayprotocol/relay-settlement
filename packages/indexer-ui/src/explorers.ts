export const HUB_CHAIN = "relay"

const EXPLORERS: Record<string, string> = {
  abstract: "https://abscan.org",
  anime: "https://explorer.anime.xyz",
  apechain: "https://apescan.io",
  arbitrum: "https://arbiscan.io",
  arbitrum_nova: "https://arbitrum-nova.blockscout.com",
  arc: "https://explorer.arc.io",
  avalanche: "https://snowtrace.io",
  base: "https://basescan.org",
  "base-sepolia": "https://sepolia.basescan.org",
  berachain: "https://berascan.com",
  bitcoin: "https://mempool.space",
  blast: "https://blastscan.io",
  bnb: "https://bscscan.com",
  bob: "https://explorer.gobob.xyz",
  boba: "https://bobascan.com",
  celo: "https://celoscan.io",
  cronos: "https://explorer.cronos.com",
  cyber: "https://cyberscan.co",
  doma: "https://explorer.doma.xyz",
  eclipse: "https://eclipsescan.xyz",
  elysium: "https://elysium.kinetiq.xyz/explorer",
  ethereal: "https://explorer.ethereal.trade",
  ethereum: "https://etherscan.io",
  flow: "https://evm.flowscan.io",
  gensyn: "https://gensyn-mainnet.explorer.alchemy.com",
  gnosis: "https://gnosisscan.io",
  gunz: "https://gunzscan.io",
  hyperevm: "https://hyperevmscan.io",
  ink: "https://explorer.inkonchain.com",
  katana: "https://explorer.katanarpc.com",
  linea: "https://lineascan.build",
  lisk: "https://blockscout.lisk.com",
  manta: "https://pacific-explorer.manta.network",
  mantle: "https://mantlescan.xyz",
  megaeth: "https://megaeth.blockscout.com",
  metis: "https://explorer.metis.io",
  mode: "https://explorer.mode.network",
  monad: "https://monadvision.com",
  morph: "https://explorer.morphl2.io",
  mythos: "https://mythos-mainnet.explorer.alchemy.com",
  optimism: "https://optimistic.etherscan.io",
  plasma: "https://plasmascan.to",
  plume: "https://explorer.plume.org",
  polygon: "https://polygonscan.com",
  relay: "https://explorer.chain.relay.link",
  robinhood: "https://robin.etherscan.io",
  ronin: "https://explorer.roninchain.com",
  scroll: "https://scrollscan.com",
  sei: "https://seiscan.io",
  sepolia: "https://sepolia.etherscan.io",
  shape: "https://shapescan.xyz",
  solana: "https://solscan.io",
  somnia: "https://explorer.somnia.network",
  soneium: "https://soneium.blockscout.com",
  sonic: "https://sonicscan.org",
  stable: "https://stablescan.xyz",
  story: "https://www.datanetscan.io",
  superseed: "https://explorer.superseed.xyz",
  taiko: "https://taikoscan.io",
  tempo: "https://explore.tempo.xyz",
  unichain: "https://uniscan.xyz",
  worldchain: "https://worldscan.org",
  xlayer: "https://xlayerscan.com",
  zero: "https://explorer.zero.network",
  zircuit: "https://explorer.zircuit.com",
  zksync: "https://explorer.zksync.io",
  zora: "https://explorer.zora.energy",
}

const ACCOUNT_PATHS: Record<string, string> = {
  eclipse: "account",
  solana: "account",
}

type ExplorerTarget = "address" | "tx"

export const explorerHost = (href: string) =>
  new URL(href).hostname.replace(/^www\./, "")

export const explorerUrl = (
  chain: string,
  target: ExplorerTarget,
  value: string
) => {
  const base = EXPLORERS[chain]
  if (!base) return undefined
  const path = target === "tx" ? "tx" : (ACCOUNT_PATHS[chain] ?? "address")
  return `${base}/${path}/${encodeURIComponent(value)}`
}
