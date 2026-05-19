import { AllocatorActionConfig } from "../../index"

import * as v1 from "./v1"

const versions: Record<
  string,
  { config: AllocatorActionConfig; code: Record<string, string> }
> = {
  v1,
}

export { versions }
