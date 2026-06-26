import { SignerClient } from "@reservoir0x/lighter-ts-sdk"

export type GeneratedLighterApiKey = {
  publicKey: string
  privateKey: string
}

export async function generateLighterApiKey({
  accountIndex,
  apiKeyIndex,
  url,
}: {
  accountIndex: number
  apiKeyIndex: number
  url: string
}): Promise<GeneratedLighterApiKey> {
  const keygen = new SignerClient({
    accountIndex,
    apiKeyIndex,
    privateKey: "00".repeat(40),
    url,
  })

  await keygen.initialize()
  await keygen.ensureWasmClient()

  const keyPair = await keygen.generateAPIKey()
  if (!keyPair) throw new Error("Failed to generate API key pair")

  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  }
}
