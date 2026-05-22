#!/usr/bin/env tsx
/**
 * Bundle the per-VM TypeScript Lit Action sources into standalone JavaScript
 * files per environment.
 *
 * Action entry sources are generated on the fly from `VM_TYPES` using a
 * convention-based name mapping:
 *
 *   "<family>-vm" -> derivation/vm/<family>/<Family>VmWalletDeriver.ts
 *
 * This keeps the per-VM action boilerplate centralized here so adding a new
 * VM is just: append to `VM_TYPES`, drop a deriver under
 * `src/derivation/vm/<family>/`, register it in `derivation/index.ts`. No
 * additional source file under `src/vm/` is required.
 *
 * Source action code imports every external dependency directly via jsDelivr
 * `+esm` URLs (see `src/action-env.d.ts`); esbuild treats those URL imports
 * as external so the resulting bundle is tiny and the Lit Action runtime
 * resolves each dependency on demand at runtime.
 *
 * Usage:
 *   tsx scripts/bundle-actions.ts --env <name>
 *
 * Outputs:
 *   dist/actions/<env>/<vm>.js  (generated per VM in `VM_TYPES`)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { VM_TYPES, loadEnvironment, parseEnvArg, type VmType } from "./env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const outDir = resolve(rootDir, "dist/actions");

/**
 * esbuild plugin that marks every `https://` import as external so the URL is
 * preserved verbatim in the bundle output.
 */
const externalUrlImports: Plugin = {
  name: "external-url-imports",
  setup(build) {
    build.onResolve({ filter: /^https?:\/\// }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

/**
 * esbuild always emits a trailing `export { main };` since each VM source
 * exports the entrypoint. Lit Actions run the bundle as a script and don't
 * tolerate that export, so strip it post-build.
 */
async function stripEsbuildMainExport(path: string): Promise<void> {
  const code = await readFile(path, "utf-8");
  const stripped = code.replace(/export\s*\{[^}]*\bmain\b[^}]*\};?\s*$/, "");
  if (stripped === code) {
    throw new Error(`failed to strip trailing export from bundled action: ${path}`);
  }
  await writeFile(path, stripped);
}

/**
 * Map a VM type to its deriver folder + class name by convention.
 *   "ethereum-vm"     -> { folder: "ethereum",     className: "EthereumVmWalletDeriver" }
 *   "hyperliquid-vm"  -> { folder: "hyperliquid",  className: "HyperliquidVmWalletDeriver" }
 */
function deriverImport(vmType: VmType): { folder: string; className: string } {
  const family = vmType.replace(/-vm$/, "");
  if (!family || family.includes("-")) {
    throw new Error(`unsupported VM family naming convention: ${vmType}`);
  }
  const pascal = family[0].toUpperCase() + family.slice(1);
  return { folder: family, className: `${pascal}VmWalletDeriver` };
}

/** Generate the per-VM action entry source consumed by esbuild's stdin. */
function actionEntrySource(vmType: VmType): string {
  const { folder, className } = deriverImport(vmType);
  return [
    `import { ${className} } from "../derivation/vm/${folder}/${className}.js";`,
    `import { runVmAction, type ActionParams, type SignResult } from "./action.js";`,
    `import type { AccountInfo, WalletInfo } from "../common/types.js";`,
    ``,
    `const deriver = new ${className}();`,
    ``,
    `export function main(`,
    `  params: ActionParams<"${vmType}">,`,
    `): Promise<AccountInfo | WalletInfo | SignResult<"${vmType}">> {`,
    `  return runVmAction("${vmType}", deriver, params);`,
    `}`,
    ``,
  ].join("\n");
}

/** Bundle a single VM action source into `dist/actions/<env>/<vm>.js`. */
async function bundleVm(envName: string, vmType: VmType, define: Record<string, string>) {
  const outfile = resolve(outDir, envName, `${vmType}.js`);
  await mkdir(dirname(outfile), { recursive: true });

  await build({
    stdin: {
      contents: actionEntrySource(vmType),
      resolveDir: resolve(rootDir, "src/vm"),
      sourcefile: `${vmType}.ts`,
      loader: "ts",
    },
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    treeShaking: true,
    legalComments: "none",
    logLevel: "silent",
    plugins: [externalUrlImports],
    define,
  });

  await stripEsbuildMainExport(outfile);
  console.log(`Bundled ${envName}/${vmType} action -> dist/actions/${envName}/${vmType}.js`);
}

const { envName } = parseEnvArg(process.argv.slice(2));
if (!envName) {
  console.error("Usage: tsx scripts/bundle-actions.ts --env <name>");
  process.exit(1);
}

const env = loadEnvironment(envName);
const define: Record<string, string> = {
  __DEPOSIT_ADDRESS_MANAGER_ADDRESS__: JSON.stringify(env.depositAddressManagerAddress),
  __HUB_EVM_CHAIN_ID__: JSON.stringify(String(env.hubEvmChainId)),
  __ALLOWED_ORACLES__: JSON.stringify(JSON.stringify(env.allowedOracles)),
  __ORACLE_SIGNATURE_THRESHOLD__: JSON.stringify(String(env.oracleSignatureThreshold)),
};

for (const vmType of VM_TYPES) {
  await bundleVm(env.name, vmType, define);
}
