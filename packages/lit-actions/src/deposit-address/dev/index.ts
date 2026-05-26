import { DepositAddressActionConfig } from "../../index"

import * as v1 from "./v1"

const versions: Record<
  string,
  { config: DepositAddressActionConfig; code: Record<string, string> }
> = {
  v1,
}

export { versions }
