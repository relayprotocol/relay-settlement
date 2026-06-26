import {
  RelayOracle,
  RelayOracleMultisig,
} from "@relay-protocol/settlement-abis"
import { Contract, getAddress, id, type Provider } from "ethers"
import type { Queryable } from "../db/connection.js"

export const ORACLE_ROLE = id("ORACLE_ROLE")

export type OracleMultisigState = {
  signers: string[]
  threshold: number
}

export type ApprovedOracleRoleMember = {
  address: string
  isContract: boolean
  multisig: OracleMultisigState | null
}

export type ApprovedOracleSummary = {
  address: string
  label: string | null
  signerCount: number
  threshold: number
  type: "contract" | "direct" | "multisig"
}

export type ApprovedOracleInstance = {
  address: string
  approvedOracle: ApprovedOracleSummary
  label: string | null
  type: "contract-role-member" | "direct-role-member" | "multisig-signer"
}

export type ApprovedOracle = ApprovedOracleSummary & {
  signers: ApprovedOracleInstance[]
}

export type ApprovedOracleInstancesResponse = {
  approvedOracles: ApprovedOracle[]
  count: number
  data: ApprovedOracleInstance[]
  oracleRole: string
  relayOracleAddress: string
  source: {
    fromBlock: number
    roleMembers: "indexed-role-members"
    verifiedAtBlock: number
  }
}

const normalizeAddress = (address: string) => getAddress(address).toLowerCase()

const listIndexedOracleRoleMembers = async (
  db: Queryable,
  relayOracleAddress: string
) => {
  const rows = await db.manyOrNone<{ account: string }>(
    `SELECT account
     FROM role_members
     WHERE contract_address = $1
       AND role = $2
     ORDER BY account ASC`,
    [normalizeAddress(relayOracleAddress), ORACLE_ROLE]
  )

  return rows.map((row) => normalizeAddress(row.account))
}

const readMultisigState = async (
  provider: Provider,
  approvedOracleAddress: string,
  blockTag: number
): Promise<OracleMultisigState | null> => {
  const contract = new Contract(
    approvedOracleAddress,
    RelayOracleMultisig,
    provider
  )

  try {
    const [signersRaw, thresholdRaw] = await Promise.all([
      contract.getSigners({ blockTag }),
      contract.threshold({ blockTag }),
    ])
    if (!Array.isArray(signersRaw)) {
      return null
    }

    return {
      signers: signersRaw.map((signer) => normalizeAddress(String(signer))),
      threshold: Number(thresholdRaw),
    }
  } catch {
    return null
  }
}

const verifyOracleRoleMember = async (
  provider: Provider,
  relayOracleAddress: string,
  memberAddress: string,
  blockTag: number
) => {
  const contract = new Contract(relayOracleAddress, RelayOracle, provider)
  return Boolean(
    await contract.hasRole(ORACLE_ROLE, memberAddress, { blockTag })
  )
}

const isContractAddress = async (
  provider: Provider,
  address: string,
  blockTag: number
) => (await provider.getCode(address, blockTag)) !== "0x"

const getRoleMemberType = (
  member: ApprovedOracleRoleMember
): ApprovedOracleSummary["type"] => {
  if (member.multisig) {
    return "multisig"
  }

  return member.isContract ? "contract" : "direct"
}

const getRoleMemberInstanceType = (
  member: ApprovedOracleRoleMember
): ApprovedOracleInstance["type"] => {
  if (member.isContract) {
    return "contract-role-member"
  }

  return "direct-role-member"
}

export const projectApprovedOracleInstances = ({
  relayOracleAddress,
  roleMembers,
  source,
}: {
  relayOracleAddress: string
  roleMembers: ApprovedOracleRoleMember[]
  source: ApprovedOracleInstancesResponse["source"]
}): ApprovedOracleInstancesResponse => {
  const approvedOracles = roleMembers.map((member): ApprovedOracle => {
    const approvedOracleAddress = normalizeAddress(member.address)

    if (member.multisig) {
      const summary: ApprovedOracleSummary = {
        address: approvedOracleAddress,
        label: null,
        signerCount: member.multisig.signers.length,
        threshold: member.multisig.threshold,
        type: "multisig",
      }

      return {
        ...summary,
        signers: member.multisig.signers.map((signer) => ({
          address: normalizeAddress(signer),
          approvedOracle: summary,
          label: null,
          type: "multisig-signer",
        })),
      }
    }

    const summary: ApprovedOracleSummary = {
      address: approvedOracleAddress,
      label: null,
      signerCount: 1,
      threshold: 1,
      type: getRoleMemberType(member),
    }

    return {
      ...summary,
      signers: [
        {
          address: approvedOracleAddress,
          approvedOracle: summary,
          label: null,
          type: getRoleMemberInstanceType(member),
        },
      ],
    }
  })
  const data = approvedOracles.flatMap((oracle) => oracle.signers)

  return {
    approvedOracles,
    count: data.length,
    data,
    oracleRole: ORACLE_ROLE,
    relayOracleAddress: normalizeAddress(relayOracleAddress),
    source,
  }
}

export const getApprovedOracleInstances = async (
  db: Queryable,
  provider: Provider,
  relayOracleAddress: string
) => {
  const normalizedRelayOracleAddress = normalizeAddress(relayOracleAddress)
  const [latestBlock, members] = await Promise.all([
    provider.getBlockNumber(),
    listIndexedOracleRoleMembers(db, normalizedRelayOracleAddress),
  ])
  const verifiedMembers = await Promise.all(
    members.map(async (member) => {
      const hasRole = await verifyOracleRoleMember(
        provider,
        normalizedRelayOracleAddress,
        member,
        latestBlock
      )
      if (!hasRole) {
        return null
      }

      const isContract = await isContractAddress(provider, member, latestBlock)

      return {
        address: member,
        isContract,
        multisig: isContract
          ? await readMultisigState(provider, member, latestBlock)
          : null,
      }
    })
  )

  return projectApprovedOracleInstances({
    relayOracleAddress: normalizedRelayOracleAddress,
    roleMembers: verifiedMembers.filter(
      (member): member is ApprovedOracleRoleMember => member != null
    ),
    source: {
      fromBlock: 0,
      roleMembers: "indexed-role-members",
      verifiedAtBlock: latestBlock,
    },
  })
}
