import type { ReactNode } from "react"
import type {
  ContractBindings,
  ContractDependencyKind,
  GetContractConfigurationResponse,
  RoleConfiguration,
} from "../api/schema"
import { roleName } from "../roles"
import { AddressLink, CopyOverlay, HashText } from "./links"
import { Tooltip } from "./Tooltip"
import {
  Badge,
  DataTable,
  KeyValuePanel,
  Panel,
  RelativeTime,
  type Column,
} from "./ui"

const ZERO_ADDRESS = /^0x0{40}$/i

export const configuredAddress = (address?: string | null) =>
  address && !ZERO_ADDRESS.test(address) ? address : undefined

export const dependency = (
  response: GetContractConfigurationResponse | undefined,
  kind: ContractDependencyKind
) => response?.dependencies.find((entry) => entry.kind === kind)

export function ConfigurationPanel({
  response,
  items,
  error,
}: {
  response?: GetContractConfigurationResponse
  items: Array<{ label: string; value?: ReactNode }>
  error?: Error | null
}) {
  const bindings = response?.state?.bindings
  return (
    <KeyValuePanel
      items={response && [...items, ...bindingItems(bindings)]}
      empty="No configuration snapshot"
      error={error}
    />
  )
}

const bindingItems = (bindings?: ContractBindings | null) =>
  bindings
    ? [
        {
          hint: "Keccak hash of deployed code",
          label: "code_hash",
          value: bindings.code_hash ? (
            <HashText value={bindings.code_hash} />
          ) : (
            <Badge tone="error" title="Address holds no code">
              No code
            </Badge>
          ),
        },
        {
          hint: "Last deployed code change seen",
          label: "code_changed",
          value: bindings.changed_at ? (
            <RelativeTime value={bindings.changed_at} />
          ) : undefined,
        },
      ]
    : []

export const addressItem = (label: string, address?: string | null) => {
  const configured = configuredAddress(address)
  return {
    label,
    value: configured && (
      <AddressLink full address={configured} className="wrap-anywhere" />
    ),
  }
}

const ROLE_COLUMNS: Column<RoleConfiguration>[] = [
  {
    cell: (role) => (
      <Tooltip content={role.role}>
        <span>{roleName(role.role)}</span>
      </Tooltip>
    ),
    header: "Role",
    title: "Contract role",
  },
  {
    cell: (role) => (
      <CopyOverlay value="always">
        <span className="flex flex-col gap-1">
          {role.members.map((member) => (
            <span
              key={member.account}
              className="inline-flex items-center gap-(--flow-gap) [--flow-gap:--spacing(2)]"
            >
              <AddressLink address={member.account} />
              {member.granted ? null : (
                <Badge tone="error" title="Account lacks this role">
                  Missing
                </Badge>
              )}
            </span>
          ))}
        </span>
      </CopyOverlay>
    ),
    header: "Members",
    title: "Role accounts and grant status",
  },
  {
    cell: (role) => (
      <Tooltip content={role.admin}>
        <span>{roleName(role.admin)}</span>
      </Tooltip>
    ),
    header: "Admin",
    title: "Role that administers this role",
  },
]

export function RolesPanel({
  roles,
  error,
}: {
  roles?: RoleConfiguration[]
  error?: Error | null
}) {
  return (
    <Panel title="Roles">
      <DataTable
        columns={ROLE_COLUMNS}
        rows={roles?.filter((role) => role.members.length)}
        rowKey={(role) => role.role}
        empty="No roles with members"
        error={error}
      />
    </Panel>
  )
}
