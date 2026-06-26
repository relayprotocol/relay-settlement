import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { Signer } from "@aws-sdk/rds-signer"

type GetIamTokenParams = {
  host: string
  port?: number
  user: string
  region?: string
}

export const getIamToken = async ({
  host,
  port = 5432,
  user,
  region = "us-east-1",
}: GetIamTokenParams) => {
  const signer = new Signer({
    credentials: fromNodeProviderChain(),
    hostname: host,
    port,
    region,
    username: user,
  })

  return signer.getAuthToken()
}
