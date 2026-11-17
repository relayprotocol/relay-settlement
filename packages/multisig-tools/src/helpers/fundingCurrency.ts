import {
  decodeFunctionData,
  erc20Abi,
  parseAbi,
  parseEther,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem"

export const TEMPO_CHAIN_ID = 4217
export const TEMPO_FEE_MANAGER = "0xfeEC000000000000000000000000000000000000"
export const PATH_USD = "0x20C0000000000000000000000000000000000000"
export const OUSD = "0x20c0000000000000000000006a37DA5C996874BE"
const TEMPO_DEX = "0xDEc0000000000000000000000000000000000000"
const feeAbi = parseAbi([
  "function userTokens(address) view returns (address)",
  "function setUserToken(address token)",
  "function currency() view returns (string)",
  "function transfer(address to, uint256 amount)",
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
  "function swapExactAmountIn(address tokenIn, address tokenOut, uint128 amountIn, uint128 minAmountOut)",
  "function swapExactAmountOut(address tokenIn, address tokenOut, uint128 amountOut, uint128 maxAmountIn)",
])

export type FundingCurrency = {
  address: Address
  decimals: number
  gasCost: bigint
  symbol: string
}

export function tempoFeeAmount(gas: bigint, gasPrice: bigint) {
  // Tempo prices gas in attodollars; TIP-20 balances use microdollars.
  return (gas * gasPrice + 10n ** 12n - 1n) / 10n ** 12n
}

export async function fundingBalance(
  client: PublicClient,
  currency: FundingCurrency,
  account: Address
) {
  return currency.address === zeroAddress
    ? client.getBalance({ address: account, blockTag: "latest" })
    : client.readContract({
        abi: erc20Abi,
        address: currency.address,
        args: [account],
        functionName: "balanceOf",
      })
}

export async function getFundingCurrency(
  client: PublicClient,
  chainId: number,
  tx: { amount: string; calldata: `0x${string}`; from: Address; to: Address },
  gas: bigint,
  gasPrice: bigint
): Promise<FundingCurrency> {
  if (chainId !== TEMPO_CHAIN_ID) {
    return {
      address: zeroAddress,
      decimals: 18,
      gasCost: gas * gasPrice,
      symbol: "native tokens",
    }
  }
  if (parseEther(tx.amount) !== 0n) {
    throw new Error("Tempo does not support native value transfers")
  }

  let call: ReturnType<typeof decodeFunctionData<typeof feeAbi>> | undefined
  try {
    call = decodeFunctionData({ abi: feeAbi, data: tx.calldata })
  } catch {
    // Ordinary contract calls use the account preference or fallback tokens.
  }

  let token = await client.readContract({
    abi: feeAbi,
    address: TEMPO_FEE_MANAGER,
    args: [tx.from],
    functionName: "userTokens",
  })
  if (
    tx.to.toLowerCase() === TEMPO_FEE_MANAGER.toLowerCase() &&
    call?.functionName === "setUserToken"
  ) {
    token = call.args[0]
  } else if (token === zeroAddress) {
    let inferred: Address | undefined
    if (
      tx.to.toLowerCase().startsWith("0x20c000000000000000000000") &&
      (call?.functionName === "transfer" ||
        call?.functionName === "transferWithMemo")
    ) {
      inferred = tx.to
    } else if (
      tx.to.toLowerCase() === TEMPO_DEX.toLowerCase() &&
      (call?.functionName === "swapExactAmountIn" ||
        call?.functionName === "swapExactAmountOut")
    ) {
      inferred = call.args[0]
    }
    if (inferred?.toLowerCase().startsWith("0x20c000000000000000000000")) {
      const denomination = await client.readContract({
        abi: feeAbi,
        address: inferred,
        functionName: "currency",
      })
      if (denomination === "USD") token = inferred
    }
  }

  const currency: FundingCurrency = {
    address: token === zeroAddress ? PATH_USD : token,
    decimals: 6,
    gasCost: tempoFeeAmount(gas, gasPrice),
    symbol: "",
  }
  // From T13, OUSD is the second fallback when pathUSD cannot cover the fee.
  // If neither covers it, fund pathUSD, the first fallback.
  if (
    token === zeroAddress &&
    (await fundingBalance(client, currency, tx.from)) < currency.gasCost &&
    (await client.getBlock()).timestamp >= 1793718000n
  ) {
    const ousdCurrency = { ...currency, address: OUSD as Address }
    if (
      (await fundingBalance(client, ousdCurrency, tx.from)) >= currency.gasCost
    ) {
      currency.address = OUSD
    }
  }
  currency.symbol = await client.readContract({
    abi: erc20Abi,
    address: currency.address,
    functionName: "symbol",
  })
  return currency
}
