import { task } from 'hardhat/config'
import { checksumAddress } from 'viem'
import { createSafeClient } from '@safe-global/sdk-starter-kit'
import { createTransactionBundle } from './utils'

type SafeTransactionAction = {
  to: string
  value: string // decimal string (wei)
  data: string // 0x…
  operation: number // 0 = CALL, 1 = DELEGATECALL
  dataDecoded?: any // decoded ABI of the inner call (if available)
}

const getPendingSafeTxActionsByNonce = async (
  apiKit: any,
  safeAddress: `0x${string}`,
  targetNonce: number
): Promise<SafeTransactionAction[]> => {
  const { results } = await apiKit.getPendingTransactions(safeAddress, {
    limit: 1000, // This breaks after 1000!
  })

  const tx = results.find(
    (transaction: any) => transaction.nonce === targetNonce
  )
  if (!tx) {
    throw new Error(
      `❌ Safe transaction not found for nonce ${targetNonce}. Please check the nonce and make sure the transaction is still pending!`
    )
  }
  let actions: SafeTransactionAction[] = [
    {
      data: tx.data || '0x',
      operation: tx.operation ?? 0,
      to: tx.to,
      value: tx.value,
    },
  ]

  // If there is calldata, try to decode it
  if (tx.data && tx.data !== '0x') {
    try {
      // Providing `to` improves accuracy in case of ABI collisions
      const decoded = await apiKit.decodeData(tx.data, tx.to)

      // Check if this is a MultiSend (method name varies by version)
      const isMultiSend =
        decoded?.method === 'multiSend' ||
        decoded?.method === 'multiSendCallOnly'

      if (isMultiSend) {
        // For MultiSend, actions live in parameters[0].valueDecoded (array)
        const inner = decoded?.parameters?.[0]?.valueDecoded ?? []
        actions = inner.map((it: any) => ({
          data: it.data ?? '0x',
          dataDecoded: it.dataDecoded, // may be undefined if ABI unknown
          operation: it.operation ?? 0,
          to: it.to,
          value: String(it.value ?? '0'),
        }))
      } else {
        // Not a batch: attach decoded ABI for convenience
        actions[0].dataDecoded = decoded
      }
    } catch {
      // Swallow decode errors; keep raw single action
    }
  }
  return actions
}

task(
  'relay-multisig-signer:check-hashes',
  'Checks transaction hashes from a transactions manifest file against a Gnosis Safe. They must match the transactions from the manifest.'
)
  .addParam('transactions', 'The path to the transactions manifest file')
  .addParam('relayMultisigSigner', 'address of the relay multisig signer')
  .addParam('safeTransactionNonce', 'nonce of the safe transaction')
  .setAction(
    async (
      {
        transactions: transactionsPath,
        relayMultisigSigner: relayMultisigSignerAddress,
        safeTransactionNonce,
      },
      hre
    ) => {
      const relayMultisigSigner = await hre.viem.getContractAt(
        'RelayMultisigSigner',
        relayMultisigSignerAddress
      )

      // TODO: should we handle this if the owner is _not_ a SAFE? (things will fail later).
      const safeMultisigAddress = await relayMultisigSigner.read.owner()

      const safe = await createSafeClient({
        apiKey: process.env.SAFE_API_KEY!,
        provider: hre.network.config.url,
        safeAddress: safeMultisigAddress,
        signer: process.env.DEPLOYER_PRIVATE_KEY,
      })

      const transactionBundle = await createTransactionBundle(
        transactionsPath,
        relayMultisigSigner
      )

      // Let's now load the transactions from the Safe
      const safeTransactionActions = await getPendingSafeTxActionsByNonce(
        safe.apiKit,
        safeMultisigAddress,
        safeTransactionNonce
      )

      if (safeTransactionActions.length !== transactionBundle.length) {
        throw new Error('❌ Action count mismatch...')
      }
      for (let i = 0; i < safeTransactionActions.length; i++) {
        const action = safeTransactionActions[i]
        if (
          checksumAddress(action.to as `0x${string}`) !==
          checksumAddress(relayMultisigSignerAddress)
        ) {
          throw new Error(
            `❌ Action ${i} is not addressed to the relay multisig signer`
          )
        }
        let matched = false
        for (let j = 0; j < transactionBundle.length; j++) {
          if (action.data === transactionBundle[j].data) {
            matched = true
          }
        }
        if (!matched) {
          throw new Error(
            `❌ Action ${i} data ${action.data} does not match any transaction!`
          )
        }
      }
      console.log(
        '✅ All actions match transactions generated from the manifest!'
      )
    }
  )
