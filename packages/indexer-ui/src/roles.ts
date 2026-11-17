import type { RoleConfiguration } from "./api/schema"
import { shortHash } from "./utils"

export const HUB_ROLES = [
  {
    hash: "0x21d1167972f621f75904fb065136bc8b53c7ba1c60ccd3a7758fbee465851e9c",
    name: "Editor",
  },
  {
    hash: "0x97667070c54ef182b0f5858b034beac1b6f3089aa2d3188bb1e8929f4fa9b929",
    name: "Operator",
  },
  {
    hash: "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775",
    name: "Admin",
  },
]

export const heldRoles = (roles: RoleConfiguration[], account: string) =>
  HUB_ROLES.filter(({ hash }) =>
    roles
      .find((role) => role.role.toLowerCase() === hash)
      ?.members.some(
        (member) =>
          member.granted &&
          member.account.toLowerCase() === account.toLowerCase()
      )
  )

const ROLE_NAMES = new Map([
  [
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "Default",
  ],
  [
    "0x68e79a7bf1e0bc45d0a330c573bc367f9cf464fd326078812f301165fbda4ef1",
    "Oracle",
  ],
  [
    "0x9d56108290ea0bc9c5c59c3ad357dca9d1b29ed7f3ae1443bef2fa2159bdf5e8",
    "Consumer",
  ],
  [
    "0x5d0fd95325d39a54fd316060ff02cc3576af885c7747cd1a96a05f9814f31f3f",
    "Writer",
  ],
  ...HUB_ROLES.map(({ hash, name }) => [hash, name] as const),
])

export const roleName = (hash: string) =>
  ROLE_NAMES.get(hash.toLowerCase()) ?? shortHash(hash)
