import { Agent as HttpAgent } from "node:http"
import { Agent as HttpsAgent } from "node:https"
import { defineConfig } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"

const target = process.env.INDEXER_API_URL ?? "http://localhost:3001"
const Agent = target.startsWith("https:") ? HttpsAgent : HttpAgent

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "vendor", test: /node_modules/ }],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        agent: new Agent({ keepAlive: true }),
        changeOrigin: true,
        headers: process.env.AUTH_API_KEY
          ? { "x-api-key": process.env.AUTH_API_KEY }
          : undefined,
        target,
      },
    },
  },
})
