import { DepositAddressActionConfig } from "../index"

import * as dev from "./dev"

const envs: Record<
  string,
  {
    versions: Record<
      string,
      { config: DepositAddressActionConfig; code: Record<string, string> }
    >
  }
> = {
  dev,
}

export { envs }
