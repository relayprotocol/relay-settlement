import { useQuery } from "@tanstack/react-query"
import { hubQueries } from "./api/queries"
import type { Token } from "./api/schema"

const byTokenId = (tokens: Token[]) =>
  new Map(tokens.map((token) => [token.token_id, token]))

export const useTokens = () =>
  useQuery({ ...hubQueries.tokens(), select: byTokenId }).data
