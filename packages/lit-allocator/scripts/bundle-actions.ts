#!/usr/bin/env tsx
/**
 * Bundle the per-VM TypeScript Lit Action sources into standalone JavaScript
 * files per environment.
 *
 * Source files import every external dependency directly via jsDelivr `+esm`
 * URLs (see `src/action-env.d.ts`); esbuild treats those URL imports as
 * external so the resulting bundle is tiny and the Lit Action runtime
 * resolves each dependency on demand at runtime.
 *
 * Usage:
 *   tsx scripts/bundle-actions.ts --env <name>
 *
 * Outputs:
 *   dist/actions/<env>/ethereum.js  (from src/vm/ethereum-vm.ts)
 *   dist/actions/<env>/solana.js    (from src/vm/solana-vm.ts)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { VM_TYPES, actionBasenameForVm, loadEnvironment, parseEnvArg, type VmType } from "./env.js";

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
 * esbuild always emits a trailing `export { main };` since the action source
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

/** Bundle a single VM action source into `dist/actions/<env>/<vm>.js`. */
async function bundleVm(envName: string, vmType: VmType, define: Record<string, string>) {
  const basename = actionBasenameForVm(vmType);
  const entry = resolve(rootDir, "src/vm", `${vmType}.ts`);
  const outfile = resolve(outDir, envName, `${basename}.js`);
  await mkdir(dirname(outfile), { recursive: true });

  await build({
    entryPoints: [entry],
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
  console.log(`Bundled ${envName}/${vmType} action -> dist/actions/${envName}/${basename}.js`);
}

const { envName } = parseEnvArg(process.argv.slice(2));
if (!envName) {
  console.error("Usage: tsx scripts/bundle-actions.ts --env <name>");
  process.exit(1);
}

const env = loadEnvironment(envName);
const define: Record<string, string> = {
  __ALLOCATOR_ADDRESS__: JSON.stringify(env.allocatorAddress),
  __HUB_EVM_CHAIN_ID__: JSON.stringify(String(env.hubEvmChainId)),
  __ALLOWED_ORACLES__: JSON.stringify(JSON.stringify(env.allowedOracles)),
  __ORACLE_SIGNATURE_THRESHOLD__: JSON.stringify(String(env.oracleSignatureThreshold)),
};

for (const vmType of VM_TYPES) {
  await bundleVm(env.name, vmType, define);
}
