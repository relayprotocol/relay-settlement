import express from "express"

export const createServer = () => {
  const app = express()

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "indexer-shell" })
  })

  app.get("/readyz", (_req, res) => {
    res.json({ ok: true, service: "indexer-shell" })
  })

  app.get("/", (_req, res) => {
    res.json({
      message:
        "Indexer shell is running. Background indexing is not enabled in this foundation build.",
      ok: true,
    })
  })

  return app
}
