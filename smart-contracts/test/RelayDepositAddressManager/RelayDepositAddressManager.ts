// ABOUTME: Tests for the RelayDepositAddressManager contract.
// ABOUTME: Covers trigger hashing, oracle wiring, duplicate detection, and input/vmType validation.
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { encodeAbiParameters, getAddress, keccak256, toHex } from "viem"
import { deployRelayDepositAddressManager } from "./fixtures"

const ORDER_ID = keccak256(toHex("order-1"))
const OTHER_ORDER_ID = keccak256(toHex("order-2"))

const EMPTY_EXTRA_DATA = "0x" as const
const NONCE = 0n

const INPUT = {
  amount: 1_000_000n,
  chainId: "1",
  currency: "0x" + "aa".repeat(20),
  vmType: "evm",
} as const

const BASE_DERIVATION_FIELDS = {
  depositor: "0x" + "11".repeat(20),
  inputVmType: "evm",
  outputChainId: "10",
  outputCurrency: "0x" + "bb".repeat(20),
  outputRecipient: "0x" + "22".repeat(20),
  outputVmType: "evm",
  refundRecipient: "0x" + "33".repeat(20),
  slippageBps: 50n,
  solver: getAddress("0x000000000000000000000000000000000000bEEF"),
} as const

function makeDerivationFields(oracleAddress: `0x${string}`) {
  return {
    ...BASE_DERIVATION_FIELDS,
    pricingOracle: getAddress(oracleAddress),
  } as const
}

const INPUT_CURRENCY = {
  chainId: INPUT.chainId,
  currency: INPUT.currency,
} as const

const OUTPUT_CURRENCY = {
  chainId: BASE_DERIVATION_FIELDS.outputChainId,
  currency: BASE_DERIVATION_FIELDS.outputCurrency,
} as const

const PRICE_DECIMALS = 8
const PRICE_EXPIRATION = 1_900_000_000n
const INPUT_PRICE = {
  amount: 123_456n,
  decimals: PRICE_DECIMALS,
  expiration: PRICE_EXPIRATION,
} as const
const OUTPUT_PRICE = {
  amount: 789_012n,
  decimals: PRICE_DECIMALS,
  expiration: PRICE_EXPIRATION,
} as const
const ZERO_PRICE = { amount: 0n, decimals: 0, expiration: 0n } as const
const PRICE_ARRAY_ABI = [
  {
    components: [
      { name: "amount", type: "uint256" },
      { name: "decimals", type: "uint8" },
      { name: "expiration", type: "uint256" },
    ],
    type: "tuple[]",
  },
] as const
const TRIGGER_HASH_ABI = [
  {
    components: [
      { name: "vmType", type: "string" },
      { name: "chainId", type: "string" },
      { name: "currency", type: "bytes" },
      { name: "amount", type: "uint256" },
    ],
    type: "tuple",
  },
  {
    components: [
      { name: "inputVmType", type: "string" },
      { name: "outputVmType", type: "string" },
      { name: "outputChainId", type: "string" },
      { name: "outputCurrency", type: "bytes" },
      { name: "outputRecipient", type: "bytes" },
      { name: "solver", type: "address" },
      { name: "pricingOracle", type: "address" },
      { name: "depositor", type: "bytes" },
      { name: "refundRecipient", type: "bytes" },
      { name: "slippageBps", type: "uint256" },
    ],
    type: "tuple",
  },
  { type: "bytes32" },
  { type: "uint256" },
  {
    components: [
      { name: "chainId", type: "string" },
      { name: "currency", type: "bytes" },
    ],
    type: "tuple[]",
  },
  {
    components: [
      { name: "amount", type: "uint256" },
      { name: "decimals", type: "uint8" },
      { name: "expiration", type: "uint256" },
    ],
    type: "tuple[]",
  },
  { type: "bytes" },
] as const

type Currency = { readonly chainId: string; readonly currency: string }
type Price = {
  readonly amount: bigint
  readonly decimals: number
  readonly expiration: bigint
}
type TriggerHashInput = {
  readonly input: typeof INPUT
  readonly derivationFields: ReturnType<typeof makeDerivationFields>
  readonly orderId: `0x${string}`
  readonly nonce: bigint
  readonly currencies: readonly Currency[]
  readonly prices: readonly Price[]
  readonly extraData: `0x${string}`
}

function encodePrices(prices: readonly Price[]) {
  return encodeAbiParameters(PRICE_ARRAY_ABI, [prices])
}

function hashTrigger(trigger: TriggerHashInput) {
  return keccak256(
    encodeAbiParameters(TRIGGER_HASH_ABI, [
      trigger.input,
      trigger.derivationFields,
      trigger.orderId,
      trigger.nonce,
      trigger.currencies,
      trigger.prices,
      trigger.extraData,
    ])
  )
}

async function seedPrices(
  oracle: Awaited<ReturnType<typeof deployRelayDepositAddressManager>>["oracle"]
) {
  await oracle.write.setPrice([
    INPUT.chainId,
    INPUT.currency,
    INPUT_PRICE.amount,
    INPUT_PRICE.decimals,
    INPUT_PRICE.expiration,
  ])
  await oracle.write.setPrice([
    BASE_DERIVATION_FIELDS.outputChainId,
    BASE_DERIVATION_FIELDS.outputCurrency,
    OUTPUT_PRICE.amount,
    OUTPUT_PRICE.decimals,
    OUTPUT_PRICE.expiration,
  ])
}

describe("RelayDepositAddressManager", function () {
  describe("trigger", function () {
    it("stores the trigger hash and emits Triggered", async function () {
      const { oracle, publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )
      await seedPrices(oracle)

      const derivationFields = makeDerivationFields(oracle.address)
      const currencies = [INPUT_CURRENCY, OUTPUT_CURRENCY]
      const expectedHash = hashTrigger({
        currencies,
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices: [INPUT_PRICE, OUTPUT_PRICE] as const,
      })

      const hash = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        NONCE,
        currencies,
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      expect(await relayDepositAddress.read.triggers([expectedHash])).to.equal(
        ORDER_ID
      )

      const events = await relayDepositAddress.getEvents.Triggered()
      expect(events).to.have.lengthOf(1)
      expect(events[0].args.orderId).to.equal(ORDER_ID)
      expect(events[0].args.triggerHash).to.equal(expectedHash)
    })

    it("accepts an empty price queries array", async function () {
      const { oracle, publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )

      const derivationFields = makeDerivationFields(oracle.address)
      const expectedHash = hashTrigger({
        currencies: [],
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices: [],
      })

      const hash = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        NONCE,
        [],
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      expect(await relayDepositAddress.read.triggers([expectedHash])).to.equal(
        ORDER_ID
      )
    })

    it("captures the oracle price at trigger time", async function () {
      const { oracle, publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )
      await seedPrices(oracle)

      // Mutate the input price after seeding to confirm the value bound into
      // the hash is the one read at trigger time, not at fixture setup.
      const updatedInputPrice = {
        amount: INPUT_PRICE.amount + 1n,
        decimals: INPUT_PRICE.decimals,
        expiration: INPUT_PRICE.expiration,
      } as const
      await oracle.write.setPrice([
        INPUT.chainId,
        INPUT.currency,
        updatedInputPrice.amount,
        updatedInputPrice.decimals,
        updatedInputPrice.expiration,
      ])

      const derivationFields = makeDerivationFields(oracle.address)
      const currencies = [INPUT_CURRENCY]
      const hash = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        NONCE,
        currencies,
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      const expectedHash = hashTrigger({
        currencies,
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices: [updatedInputPrice],
      })

      expect(await relayDepositAddress.read.triggers([expectedHash])).to.equal(
        ORDER_ID
      )
    })

    it("queries the oracle referenced by derivationFields.pricingOracle", async function () {
      const { publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )

      // Deploy a second oracle and seed it with distinct prices.
      const altOracle = await hre.viem.deployContract("MockPricingOracle")
      const altInputPrice = {
        amount: 999_999n,
        decimals: 6,
        expiration: PRICE_EXPIRATION + 1n,
      } as const
      await altOracle.write.setPrice([
        INPUT.chainId,
        INPUT.currency,
        altInputPrice.amount,
        altInputPrice.decimals,
        altInputPrice.expiration,
      ])

      const derivationFields = makeDerivationFields(altOracle.address)
      const currencies = [INPUT_CURRENCY]
      const hash = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        NONCE,
        currencies,
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      const expectedHash = hashTrigger({
        currencies,
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices: [altInputPrice],
      })

      expect(await relayDepositAddress.read.triggers([expectedHash])).to.equal(
        ORDER_ID
      )
    })

    it("uses prices supplied through extraData by BasicPricingOracle", async function () {
      const { publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )

      const basicOracle = await hre.viem.deployContract("BasicPricingOracle")
      const derivationFields = makeDerivationFields(basicOracle.address)
      const currencies = [INPUT_CURRENCY, OUTPUT_CURRENCY]
      const prices = [INPUT_PRICE, OUTPUT_PRICE] as const
      const extraData = encodePrices(prices)

      const hash = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        NONCE,
        currencies,
        extraData,
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      const expectedHash = hashTrigger({
        currencies,
        derivationFields,
        extraData,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices,
      })

      expect(await relayDepositAddress.read.triggers([expectedHash])).to.equal(
        ORDER_ID
      )
    })

    it("reverts when BasicPricingOracle receives the wrong number of prices", async function () {
      const { relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )

      const basicOracle = await hre.viem.deployContract("BasicPricingOracle")
      const derivationFields = makeDerivationFields(basicOracle.address)
      const currencies = [INPUT_CURRENCY, OUTPUT_CURRENCY]
      const extraData = encodePrices([INPUT_PRICE])

      await expect(
        relayDepositAddress.write.trigger([
          INPUT,
          derivationFields,
          ORDER_ID,
          NONCE,
          currencies,
          extraData,
        ])
      ).to.be.rejectedWith("PriceCountMismatch")
    })

    it("binds price expiration into the trigger hash", async function () {
      const { oracle, publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )
      await oracle.write.setPrice([
        INPUT.chainId,
        INPUT.currency,
        INPUT_PRICE.amount,
        INPUT_PRICE.decimals,
        INPUT_PRICE.expiration,
      ])

      const derivationFields = makeDerivationFields(oracle.address)
      const currencies = [INPUT_CURRENCY]
      const hash = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        NONCE,
        currencies,
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      const matchingHash = hashTrigger({
        currencies,
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices: [INPUT_PRICE],
      })
      // Same amount and decimals, different expiration: should not collide.
      const mismatchedHash = hashTrigger({
        currencies,
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices: [
          {
            amount: INPUT_PRICE.amount,
            decimals: INPUT_PRICE.decimals,
            expiration: INPUT_PRICE.expiration + 1n,
          },
        ],
      })

      expect(matchingHash).to.not.equal(mismatchedHash)
      expect(await relayDepositAddress.read.triggers([matchingHash])).to.equal(
        ORDER_ID
      )
      expect(
        await relayDepositAddress.read.triggers([mismatchedHash])
      ).to.equal(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      )
    })

    it("binds price decimals into the trigger hash", async function () {
      const { oracle, publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )
      await oracle.write.setPrice([
        INPUT.chainId,
        INPUT.currency,
        INPUT_PRICE.amount,
        INPUT_PRICE.decimals,
        INPUT_PRICE.expiration,
      ])

      const derivationFields = makeDerivationFields(oracle.address)
      const currencies = [INPUT_CURRENCY]
      const hash = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        NONCE,
        currencies,
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      const matchingHash = hashTrigger({
        currencies,
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices: [INPUT_PRICE],
      })
      // Same amount, different decimals: should not collide.
      const mismatchedHash = hashTrigger({
        currencies,
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices: [
          {
            amount: INPUT_PRICE.amount,
            decimals: 6,
            expiration: INPUT_PRICE.expiration,
          },
        ],
      })

      expect(matchingHash).to.not.equal(mismatchedHash)
      expect(await relayDepositAddress.read.triggers([matchingHash])).to.equal(
        ORDER_ID
      )
      expect(
        await relayDepositAddress.read.triggers([mismatchedHash])
      ).to.equal(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      )
    })

    it("binds the nonce into the trigger hash", async function () {
      const { oracle, publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )
      await seedPrices(oracle)

      const derivationFields = makeDerivationFields(oracle.address)
      const currencies = [INPUT_CURRENCY]

      // Trigger the same logical operation twice with different nonces — both
      // should succeed because the trigger hash is bound to the nonce.
      const firstNonce = 1n
      const secondNonce = 2n

      const tx1 = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        firstNonce,
        currencies,
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash: tx1 })

      const tx2 = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        secondNonce,
        currencies,
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash: tx2 })

      const firstHash = hashTrigger({
        currencies,
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: firstNonce,
        orderId: ORDER_ID,
        prices: [INPUT_PRICE],
      })
      const secondHash = hashTrigger({
        currencies,
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: secondNonce,
        orderId: ORDER_ID,
        prices: [INPUT_PRICE],
      })

      expect(firstHash).to.not.equal(secondHash)
      expect(await relayDepositAddress.read.triggers([firstHash])).to.equal(
        ORDER_ID
      )
      expect(await relayDepositAddress.read.triggers([secondHash])).to.equal(
        ORDER_ID
      )
    })

    it("binds extraData into the trigger hash", async function () {
      const { oracle, publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )
      await seedPrices(oracle)

      const derivationFields = makeDerivationFields(oracle.address)
      const currencies = [INPUT_CURRENCY]
      const extraData = "0xdeadbeefcafebabe" as const

      const hash = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        NONCE,
        currencies,
        extraData,
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      const matchingHash = hashTrigger({
        currencies,
        derivationFields,
        extraData,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices: [INPUT_PRICE],
      })
      const mismatchedHash = hashTrigger({
        currencies,
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices: [INPUT_PRICE],
      })

      expect(await relayDepositAddress.read.triggers([matchingHash])).to.equal(
        ORDER_ID
      )
      // A trigger hash computed with different extraData should not collide.
      expect(
        await relayDepositAddress.read.triggers([mismatchedHash])
      ).to.equal(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      )
    })

    it("reverts with InvalidOrderId when the order id is zero", async function () {
      const { oracle, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )

      const derivationFields = makeDerivationFields(oracle.address)
      const zeroOrderId =
        "0x0000000000000000000000000000000000000000000000000000000000000000" as const

      await expect(
        relayDepositAddress.write.trigger([
          INPUT,
          derivationFields,
          zeroOrderId,
          NONCE,
          [],
          EMPTY_EXTRA_DATA,
        ])
      ).to.be.rejectedWith("InvalidOrderId")
    })

    it("reverts with InputVmTypeMismatch when vm types differ", async function () {
      const { oracle, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )

      const derivationFields = makeDerivationFields(oracle.address)
      const mismatchedInput = { ...INPUT, vmType: "svm" } as const

      await expect(
        relayDepositAddress.write.trigger([
          mismatchedInput,
          derivationFields,
          ORDER_ID,
          NONCE,
          [],
          EMPTY_EXTRA_DATA,
        ])
      ).to.be.rejectedWith("InputVmTypeMismatch")
    })

    it("reverts with AlreadyTriggered when the same trigger is replayed", async function () {
      const { oracle, publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )
      await seedPrices(oracle)

      const derivationFields = makeDerivationFields(oracle.address)
      const currencies = [INPUT_CURRENCY, OUTPUT_CURRENCY]
      const hash = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        NONCE,
        currencies,
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      await expect(
        relayDepositAddress.write.trigger([
          INPUT,
          derivationFields,
          ORDER_ID,
          NONCE,
          currencies,
          EMPTY_EXTRA_DATA,
        ])
      ).to.be.rejectedWith("AlreadyTriggered")
    })

    it("allows two different order ids to coexist", async function () {
      const { oracle, publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )
      await seedPrices(oracle)

      const derivationFields = makeDerivationFields(oracle.address)
      const currencies = [INPUT_CURRENCY, OUTPUT_CURRENCY]

      const tx1 = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        NONCE,
        currencies,
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash: tx1 })

      const tx2 = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        OTHER_ORDER_ID,
        NONCE,
        currencies,
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash: tx2 })

      const events = await relayDepositAddress.getEvents.Triggered(
        {},
        { fromBlock: 0n }
      )
      expect(events).to.have.lengthOf(2)
      const orderIds = events.map((e) => e.args.orderId).sort()
      expect(orderIds).to.deep.equal([ORDER_ID, OTHER_ORDER_ID].sort())
    })

    it("uses a default oracle price of zero for unseeded tokens", async function () {
      const { oracle, publicClient, relayDepositAddress } = await loadFixture(
        deployRelayDepositAddressManager
      )

      const derivationFields = makeDerivationFields(oracle.address)
      const currencies = [INPUT_CURRENCY]
      const expectedHash = hashTrigger({
        currencies,
        derivationFields,
        extraData: EMPTY_EXTRA_DATA,
        input: INPUT,
        nonce: NONCE,
        orderId: ORDER_ID,
        prices: [ZERO_PRICE],
      })

      const hash = await relayDepositAddress.write.trigger([
        INPUT,
        derivationFields,
        ORDER_ID,
        NONCE,
        currencies,
        EMPTY_EXTRA_DATA,
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      expect(await relayDepositAddress.read.triggers([expectedHash])).to.equal(
        ORDER_ID
      )
    })
  })
})
