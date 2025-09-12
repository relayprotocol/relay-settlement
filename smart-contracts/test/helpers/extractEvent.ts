import { decodeEventLog, decodeEventLog, TransactionReceipt } from 'viem'

interface PayloadBuiltEvent {
  args: {
    withdrawRequestHash: `0x${string}`
    payload: `0x${string}`
  }
}

export const extractEvent = async (
  receipt: TransactionReceipt,
  eventName: string,
  abi: any
) => {
  const [event] = receipt.logs
    .map((log) => {
      try {
        return decodeEventLog({
          abi,
          data: log.data,
          eventName,
          topics: log.topics,
        })
      } catch {
        return null // or filter out unrecognized events
      }
    })
    .filter((e) => e !== null)
  return event as unknown as PayloadBuiltEvent
}
