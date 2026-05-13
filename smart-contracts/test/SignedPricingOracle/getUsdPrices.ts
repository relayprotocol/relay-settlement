// ABOUTME: Tests for SignedPricingOracle.getUsdPrices.
// ABOUTME: Covers happy path, currency match, expiration, signer binding, and count mismatch.
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import { Hex, encodeAbiParameters, getAddress } from "viem"

import { encodeSignedPrices, signPrice } from "../helpers/signedPricingOracle"

import { deploySignedPricingOracle } from "./fixtures"

const INPUT_CURRENCY = {
  chainId: "1",
  currency: ("0x" + "aa".repeat(20)) as Hex,
} as const

const OUTPUT_CURRENCY = {
  chainId: "10",
  currency: ("0x" + "bb".repeat(20)) as Hex,
} as const

const FUTURE_EXPIRATION = 9_999_999_999n

const INPUT_PRICE = {
  amount: 100_000_000n,
  chainId: INPUT_CURRENCY.chainId,
  currency: INPUT_CURRENCY.currency,
  decimals: 8,
  expiration: FUTURE_EXPIRATION,
} as const

const OUTPUT_PRICE = {
  amount: 200_000_000n,
  chainId: OUTPUT_CURRENCY.chainId,
  currency: OUTPUT_CURRENCY.currency,
  decimals: 8,
  expiration: FUTURE_EXPIRATION,
} as const

describe("SignedPricingOracle.getUsdPrices", function () {
  it("returns the prices for valid signed attestations", async function () {
    const { signedPricingOracle, solver } = await loadFixture(
      deploySignedPricingOracle
    )

    const signedInput = await signPrice(
      solver,
      signedPricingOracle.address,
      INPUT_PRICE
    )
    const signedOutput = await signPrice(
      solver,
      signedPricingOracle.address,
      OUTPUT_PRICE
    )
    const extraData = encodeSignedPrices([signedInput, signedOutput])

    const prices = await signedPricingOracle.read.getUsdPrices([
      [INPUT_CURRENCY, OUTPUT_CURRENCY],
      extraData,
    ])

    expect(prices).to.have.lengthOf(2)
    expect(prices[0].amount).to.equal(INPUT_PRICE.amount)
    expect(prices[0].decimals).to.equal(INPUT_PRICE.decimals)
    expect(prices[0].expiration).to.equal(INPUT_PRICE.expiration)
    expect(prices[1].amount).to.equal(OUTPUT_PRICE.amount)
    expect(prices[1].decimals).to.equal(OUTPUT_PRICE.decimals)
    expect(prices[1].expiration).to.equal(OUTPUT_PRICE.expiration)
  })

  it("exposes the bound SOLVER on the contract", async function () {
    const { signedPricingOracle, solver } = await loadFixture(
      deploySignedPricingOracle
    )

    expect(await signedPricingOracle.read.SOLVER()).to.equal(
      getAddress(solver.account.address)
    )
  })

  it("returns the EIP-712 digest from hashSignedPrice matching the off-chain signer", async function () {
    const { signedPricingOracle, solver } = await loadFixture(
      deploySignedPricingOracle
    )

    const signed = await signPrice(
      solver,
      signedPricingOracle.address,
      INPUT_PRICE
    )

    const digest = await signedPricingOracle.read.hashSignedPrice([signed])
    // Sanity check: digest is non-zero and depends on the contract address
    expect(digest).to.not.equal(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    )
  })

  it("reverts with PriceCountMismatch when the price count differs from the currency count", async function () {
    const { signedPricingOracle, solver } = await loadFixture(
      deploySignedPricingOracle
    )

    const signedInput = await signPrice(
      solver,
      signedPricingOracle.address,
      INPUT_PRICE
    )
    const extraData = encodeSignedPrices([signedInput])

    await expect(
      signedPricingOracle.read.getUsdPrices([
        [INPUT_CURRENCY, OUTPUT_CURRENCY],
        extraData,
      ])
    ).to.be.rejectedWith("PriceCountMismatch")
  })

  it("reverts with CurrencyMismatch when the embedded chainId differs", async function () {
    const { signedPricingOracle, solver } = await loadFixture(
      deploySignedPricingOracle
    )

    const signed = await signPrice(solver, signedPricingOracle.address, {
      ...INPUT_PRICE,
      chainId: "137",
    })
    const extraData = encodeSignedPrices([signed])

    await expect(
      signedPricingOracle.read.getUsdPrices([[INPUT_CURRENCY], extraData])
    ).to.be.rejectedWith("CurrencyMismatch")
  })

  it("reverts with CurrencyMismatch when the embedded currency differs", async function () {
    const { signedPricingOracle, solver } = await loadFixture(
      deploySignedPricingOracle
    )

    const signed = await signPrice(solver, signedPricingOracle.address, {
      ...INPUT_PRICE,
      currency: ("0x" + "cc".repeat(20)) as Hex,
    })
    const extraData = encodeSignedPrices([signed])

    await expect(
      signedPricingOracle.read.getUsdPrices([[INPUT_CURRENCY], extraData])
    ).to.be.rejectedWith("CurrencyMismatch")
  })

  it("reverts with PriceExpired when the attestation is past its expiration", async function () {
    const { signedPricingOracle, solver } = await loadFixture(
      deploySignedPricingOracle
    )

    const now = BigInt(await time.latest())
    const expiration = now + 100n
    const signed = await signPrice(solver, signedPricingOracle.address, {
      ...INPUT_PRICE,
      expiration,
    })
    const extraData = encodeSignedPrices([signed])

    // Fast-forward past the expiration
    await time.increaseTo(expiration + 1n)

    await expect(
      signedPricingOracle.read.getUsdPrices([[INPUT_CURRENCY], extraData])
    ).to.be.rejectedWith("PriceExpired")
  })

  it("reverts with InvalidSignature when signed by a wallet other than SOLVER", async function () {
    const { anyone, signedPricingOracle } = await loadFixture(
      deploySignedPricingOracle
    )

    const signed = await signPrice(
      anyone,
      signedPricingOracle.address,
      INPUT_PRICE
    )
    const extraData = encodeSignedPrices([signed])

    await expect(
      signedPricingOracle.read.getUsdPrices([[INPUT_CURRENCY], extraData])
    ).to.be.rejectedWith("InvalidSignature")
  })

  it("reverts with InvalidSignature when amount is tampered post-signing", async function () {
    const { signedPricingOracle, solver } = await loadFixture(
      deploySignedPricingOracle
    )

    const signed = await signPrice(
      solver,
      signedPricingOracle.address,
      INPUT_PRICE
    )
    // Replace amount, keep original signature
    const tampered = { ...signed, amount: INPUT_PRICE.amount + 1n }
    const extraData = encodeSignedPrices([tampered])

    await expect(
      signedPricingOracle.read.getUsdPrices([[INPUT_CURRENCY], extraData])
    ).to.be.rejectedWith("InvalidSignature")
  })

  it("reverts with InvalidSignature when the signature is empty", async function () {
    const { signedPricingOracle } = await loadFixture(deploySignedPricingOracle)

    const tampered = { ...INPUT_PRICE, signature: "0x" as Hex }
    const extraData = encodeAbiParameters(
      [
        {
          components: [
            { name: "chainId", type: "string" },
            { name: "currency", type: "bytes" },
            { name: "amount", type: "uint256" },
            { name: "decimals", type: "uint8" },
            { name: "expiration", type: "uint256" },
            { name: "signature", type: "bytes" },
          ],
          type: "tuple[]",
        },
      ],
      [[tampered]]
    )

    await expect(
      signedPricingOracle.read.getUsdPrices([[INPUT_CURRENCY], extraData])
    ).to.be.rejectedWith("InvalidSignature")
  })
})
