FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache g++ make python3

ENV YARN_HTTP_TIMEOUT=120000
ENV YARN_NETWORK_CONCURRENCY=8

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY packages ./packages
COPY smart-contracts ./smart-contracts

RUN node .yarn/releases/yarn-4.9.1.cjs install --immutable
RUN node .yarn/releases/yarn-4.9.1.cjs workspace @relay-settlement/indexer-ui build

FROM nginx:1.27-alpine AS runner

COPY --chown=root:root --chmod=755 packages/indexer-ui/entrypoint.sh /entrypoint.sh
COPY packages/indexer-ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY packages/indexer-ui/config.template.js /usr/share/nginx/html/config.template.js
COPY --from=builder /app/packages/indexer-ui/dist /usr/share/nginx/html

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
