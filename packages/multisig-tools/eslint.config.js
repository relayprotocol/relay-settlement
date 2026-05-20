const sharedConfig = require("@relay-settlement/eslint-config")

module.exports = [
  ...sharedConfig,
  {
    ignores: ["dist/**/*", "node_modules/**/*"],
  },
]
