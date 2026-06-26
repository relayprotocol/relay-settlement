import { VM_TYPES, type VmType } from "./types.js";

/** Type guard for {@link VmType}. */
function isVmType(value: unknown): value is VmType {
  return typeof value === "string" && (VM_TYPES as readonly string[]).includes(value);
}

/** Assert a value is a supported {@link VmType}, throwing otherwise. */
export function assertVmType(value: unknown, field: string): VmType {
  if (!isVmType(value)) {
    throw new Error(`unsupported ${field}: ${String(value)}`);
  }
  return value;
}
