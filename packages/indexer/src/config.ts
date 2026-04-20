import dotenv from "dotenv"

dotenv.config()

export const resolvePort = (value: string | undefined) => {
  if (!value) {
    return 3001
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 3001
}

export const config = {
  port: resolvePort(process.env.PORT),
}
