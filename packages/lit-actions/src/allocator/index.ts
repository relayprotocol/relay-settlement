import { AllocatorActionConfig } from "../index"

import * as dev from "./dev"
import * as prod from "./prod"

const envs: Record<
  string,
  {
    versions: Record<
      string,
      { config: AllocatorActionConfig; code: Record<string, string> }
    >
  }
> = {
  dev,
  prod,
}

export { envs }
