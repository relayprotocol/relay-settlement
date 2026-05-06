import { AllocatorActionConfig } from "../../index"

import * as dev from "./dev"

const envs: Record<
  string,
  { config: AllocatorActionConfig; code: Record<string, string> }
> = {
  dev,
}

export { envs }
