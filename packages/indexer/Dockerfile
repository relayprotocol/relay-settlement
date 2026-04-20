FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY packages ./packages

RUN yarn install --immutable
RUN yarn workspace @relay-settlement/indexer build

FROM node:20-alpine AS runner

WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY packages ./packages
COPY --from=builder /app/packages/indexer/dist ./packages/indexer/dist

RUN yarn install --immutable

WORKDIR /app/packages/indexer

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["yarn", "start"]
