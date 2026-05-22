#!/usr/bin/env tsx
/**
 * Add credits to a Chipotle account by paying with cryptocurrency (USDC, ETH,
 * SOL, USDP — whatever Stripe's crypto on-ramp currently supports).
 *
 * The on-chain settlement is handled by Stripe's crypto payment integration;
 * this script is just the orchestrator:
 *
 *   1. GET  /billing/stripe_config         → Stripe publishable key
 *   2. POST /billing/create_payment_intent → client_secret + payment_intent_id
 *   3. Start a local HTTP server that serves a one-page Stripe.js form.
 *   4. Open the browser to that page; user connects a wallet and approves
 *      the on-chain transaction in Stripe's hosted flow.
 *   5. When Stripe redirects back (after on-chain confirmation, typically
 *      1–5 minutes), the local server signals completion.
 *   6. POST /billing/confirm_payment       → credits applied
 *   7. GET  /billing/balance               → print the new balance
 *
 * Requires `--account-api-key` (admin); usage keys don't have billing scope.
 *
 * Usage:
 *   tsx scripts/top-up.ts --account-api-key <key> --amount-cents <n> [--port <n>]
 *
 * Example:
 *   tsx scripts/top-up.ts --account-api-key lit_... --amount-cents 2500   # $25.00
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { spawn } from "node:child_process"
import type { AddressInfo } from "node:net"

const BASE_URL = "https://api.chipotle.litprotocol.com"
const MIN_AMOUNT_CENTS = 500

const USAGE =
  "Usage:\n" +
  "  tsx scripts/top-up.ts --account-api-key <key> --amount-cents <n> [--port <n>]"

/** Read a CLI flag value accepting `--name value` or `--name=value`. */
function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx !== -1) {
    return args[idx + 1]
  }
  const prefix = `${name}=`
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

interface StripeConfigResponse {
  publishable_key: string
}
interface CreatePaymentIntentResponse {
  client_secret: string
  payment_intent_id: string
}
interface ConfirmPaymentResponse {
  balance_cents?: number
  balance_display?: string
  [k: string]: unknown
}
interface BillingBalanceResponse {
  balance_cents: number
  balance_display: string
}

/** Authenticated POST against the Chipotle billing API. */
async function billingPost<T>(
  path: string,
  apiKey: string,
  body: object
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${path} failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as T
}

/** Authenticated GET against the Chipotle billing API. */
async function billingGet<T>(path: string, apiKey?: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: apiKey ? { "X-Api-Key": apiKey } : {},
  })
  if (!res.ok) {
    throw new Error(`${path} failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as T
}

/**
 * Best-effort cross-platform "open this URL in the default browser".
 * Falls back silently — we always print the URL anyway.
 */
function tryOpenBrowser(url: string): void {
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["open", [url]]]
      : process.platform === "win32"
        ? [["cmd", ["/c", "start", "", url]]]
        : [
            ["xdg-open", [url]],
            ["gnome-open", [url]],
          ]
  for (const [cmd, args] of candidates) {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true })
      child.on("error", () => {})
      child.unref()
      return
    } catch {
      // try next
    }
  }
}

/** Build the one-page Stripe.js form served from `GET /`. */
function buildPaymentPageHtml(
  publishableKey: string,
  clientSecret: string,
  amountCents: number
): string {
  const dollars = (amountCents / 100).toFixed(2)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Lit Account — Top Up ($${dollars})</title>
  <script src="https://js.stripe.com/v3/"></script>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 480px; margin: 40px auto; padding: 0 16px; line-height: 1.4; }
    h1 { margin-bottom: 8px; }
    .meta { color: #666; margin-bottom: 24px; }
    #payment-element { margin: 24px 0; }
    button { width: 100%; padding: 12px; font-size: 16px; cursor: pointer; }
    #message { margin-top: 16px; color: #c00; min-height: 1.5em; }
    code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
    @media (prefers-color-scheme: dark) {
      code { background: #333; }
    }
  </style>
</head>
<body>
  <h1>Top up Lit account</h1>
  <div class="meta">Amount: <strong>$${dollars}</strong> · paying with crypto via Stripe</div>
  <div id="payment-element"></div>
  <button id="submit" disabled>Pay $${dollars}</button>
  <div id="message"></div>
  <script>
    (async () => {
      const stripe = Stripe(${JSON.stringify(publishableKey)});
      const elements = stripe.elements({ clientSecret: ${JSON.stringify(clientSecret)} });
      const paymentElement = elements.create("payment");
      paymentElement.mount("#payment-element");
      paymentElement.on("ready", () => {
        document.getElementById("submit").disabled = false;
      });

      document.getElementById("submit").addEventListener("click", async () => {
        const btn = document.getElementById("submit");
        btn.disabled = true;
        btn.textContent = "Confirming…";
        const { error } = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: window.location.origin + "/done" },
        });
        if (error) {
          document.getElementById("message").textContent = error.message || "Payment failed";
          btn.disabled = false;
          btn.textContent = "Pay $${dollars}";
        }
      });
    })().catch((e) => {
      document.getElementById("message").textContent = String(e && e.message || e);
    });
  </script>
</body>
</html>`
}

/** Build the success-redirect page served at `/done?...`. */
function buildDonePageHtml(status: string): string {
  const ok = status === "succeeded"
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Lit Account — ${ok ? "Payment received" : "Payment status"}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 16px; text-align: center; }
    h1 { color: ${ok ? "#0a0" : "#c00"}; }
  </style>
</head>
<body>
  <h1>${ok ? "✓ Payment received" : "Payment status: " + status}</h1>
  <p>${
    ok
      ? "Stripe confirmed the on-chain payment. The CLI is now crediting your account — you can close this window."
      : "Return to the CLI for details."
  }</p>
</body>
</html>`
}

/**
 * Boot the local web server, return its base URL and a promise that resolves
 * with Stripe's redirect query string when the payment settles (or rejects on
 * timeout / explicit cancel).
 */
function serveStripeForm(
  publishableKey: string,
  clientSecret: string,
  amountCents: number,
  port: number
): Promise<{
  baseUrl: string
  done: Promise<{ status: string; paymentIntentId: string }>
  close: () => void
}> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveDone: (v: { status: string; paymentIntentId: string }) => void
    let rejectDone: (e: Error) => void
    const done = new Promise<{ status: string; paymentIntentId: string }>(
      (res, rej) => {
        resolveDone = res
        rejectDone = rej
      }
    )

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost")
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(buildPaymentPageHtml(publishableKey, clientSecret, amountCents))
        return
      }
      if (req.method === "GET" && url.pathname === "/done") {
        const status = url.searchParams.get("redirect_status") ?? "unknown"
        const paymentIntentId = url.searchParams.get("payment_intent") ?? ""
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(buildDonePageHtml(status))
        if (status === "succeeded" && paymentIntentId) {
          resolveDone({ status, paymentIntentId })
        } else {
          rejectDone(
            new Error(
              `Stripe returned redirect_status="${status}"${
                paymentIntentId ? ` (payment_intent=${paymentIntentId})` : ""
              }`
            )
          )
        }
        return
      }
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204).end()
        return
      }
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("not found")
    })

    server.on("error", (e) => rejectServer(e))
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${address.port}`
      resolveServer({
        baseUrl,
        done,
        close: () => server.close(),
      })
    })
  })
}

async function main() {
  const args = process.argv.slice(2)
  const accountApiKey = getOption(args, "--account-api-key")
  const amountCentsArg = getOption(args, "--amount-cents")
  const portArg = getOption(args, "--port")
  const missing: string[] = []
  if (!accountApiKey) {
    missing.push("--account-api-key <key>")
  }
  if (!amountCentsArg) {
    missing.push("--amount-cents <n>")
  }
  if (missing.length > 0 || !accountApiKey || !amountCentsArg) {
    console.error(`Missing ${missing.join(", ")}.\n\n${USAGE}`)
    process.exit(1)
  }
  const amountCents = Number.parseInt(amountCentsArg, 10)
  if (!Number.isFinite(amountCents) || amountCents < MIN_AMOUNT_CENTS) {
    console.error(
      `--amount-cents must be an integer >= ${MIN_AMOUNT_CENTS} (= $5.00 minimum)`
    )
    process.exit(1)
  }
  const port = portArg ? Number.parseInt(portArg, 10) : 0
  if (!Number.isFinite(port) || port < 0) {
    console.error(`invalid --port: ${portArg}`)
    process.exit(1)
  }

  console.log(`💳 Crypto top-up, amount=$${(amountCents / 100).toFixed(2)}`)
  console.log()

  // ── 1. Stripe publishable key ───────────────────────────────────────────
  console.log("1. Fetching Stripe publishable key...")
  const stripeConfig = await billingGet<StripeConfigResponse>(
    "/core/v1/billing/stripe_config"
  )
  console.log(
    `   ✓ publishable_key=${stripeConfig.publishable_key.slice(0, 12)}…`
  )

  // ── 2. Create PaymentIntent ─────────────────────────────────────────────
  console.log("2. Creating Stripe PaymentIntent...")
  const intent = await billingPost<CreatePaymentIntentResponse>(
    "/core/v1/billing/create_payment_intent",
    accountApiKey,
    { amount_cents: amountCents }
  )
  console.log(`   ✓ payment_intent_id=${intent.payment_intent_id}`)

  // ── 3. Local server + browser ───────────────────────────────────────────
  console.log("3. Starting local web server for Stripe.js Payment Element...")
  const { baseUrl, done, close } = await serveStripeForm(
    stripeConfig.publishable_key,
    intent.client_secret,
    amountCents,
    port
  )
  console.log(`   ✓ serving at ${baseUrl}/`)
  console.log()
  console.log(
    "   👉 Opening your browser. If it doesn't open, visit the URL above manually."
  )
  console.log(
    "      Connect a wallet (USDC/ETH/SOL/USDP supported via Stripe crypto on-ramp),"
  )
  console.log(
    "      approve the on-chain transaction, and Stripe will redirect back here once"
  )
  console.log("      the payment confirms (typically 1–5 minutes).")
  console.log()
  tryOpenBrowser(`${baseUrl}/`)

  // ── 4. Wait for Stripe redirect ─────────────────────────────────────────
  let redirect: { status: string; paymentIntentId: string }
  try {
    redirect = await done
  } catch (e) {
    close()
    throw e
  }
  console.log(`   ✓ Stripe redirected: status=${redirect.status}`)
  close()

  // ── 5. Confirm + credit ─────────────────────────────────────────────────
  console.log("4. Calling /billing/confirm_payment to credit the account...")
  const confirmed = await billingPost<ConfirmPaymentResponse>(
    "/core/v1/billing/confirm_payment",
    accountApiKey,
    { payment_intent_id: redirect.paymentIntentId }
  )
  console.log("   ✓ confirmed:", JSON.stringify(confirmed))

  // ── 6. Show new balance ─────────────────────────────────────────────────
  console.log("5. Reading new balance...")
  const balance = await billingGet<BillingBalanceResponse>(
    "/core/v1/billing/balance",
    accountApiKey
  )
  console.log(
    `   ✓ ${balance.balance_display} (balance_cents=${balance.balance_cents})`
  )
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err)
  process.exit(1)
})
