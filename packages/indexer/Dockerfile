FROM node:20-alpine AS base

WORKDIR /app

RUN apk add --no-cache g++ make python3

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY packages ./packages
COPY smart-contracts ./smart-contracts

FROM base AS builder

RUN node .yarn/releases/yarn-4.9.1.cjs install --immutable
RUN node .yarn/releases/yarn-4.9.1.cjs workspace @relay-protocol/settlement-sdk clean && node .yarn/releases/yarn-4.9.1.cjs workspace @relay-protocol/settlement-sdk build
RUN node .yarn/releases/yarn-4.9.1.cjs workspace @relay-protocol/settlement-networks clean && node .yarn/releases/yarn-4.9.1.cjs workspace @relay-protocol/settlement-networks build
RUN node .yarn/releases/yarn-4.9.1.cjs workspace @relay-settlement/indexer clean && node .yarn/releases/yarn-4.9.1.cjs workspace @relay-settlement/indexer build

FROM base AS prod-deps

RUN node .yarn/releases/yarn-4.9.1.cjs workspaces focus @relay-settlement/indexer --production

FROM node:20-alpine AS runner

WORKDIR /app

COPY packages/indexer/package.json ./packages/indexer/package.json
COPY packages/abis/package.json ./packages/abis/package.json
COPY packages/networks/package.json ./packages/networks/package.json
COPY --from=builder /app/packages/abis/dist ./packages/abis/dist
COPY --from=builder /app/packages/indexer/dist ./packages/indexer/dist
COPY --from=builder /app/packages/networks/dist ./packages/networks/dist
COPY --from=prod-deps /app/node_modules ./node_modules

WORKDIR /app/packages/indexer

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
