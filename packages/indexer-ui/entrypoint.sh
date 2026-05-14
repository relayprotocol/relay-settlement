#!/bin/sh
set -eu
set -a
if [ -d /vault/secrets ]; then
  for f in /vault/secrets/*; do
    [ -f "$f" ] && . "$f" || true
  done
fi
set +a

if [ -z "${INDEXER_API_URL:-}" ]; then
  echo "INDEXER_API_URL is required"
  exit 1
fi

if [ -z "${AUTH_API_KEY:-}" ]; then
  echo "AUTH_API_KEY is required"
  exit 1
fi

indexer_api_url=$(printf '%s' "$INDEXER_API_URL" | sed 's:/*$::')
case "$indexer_api_url" in
  http://*/* | https://*/*)
    echo "INDEXER_API_URL must be an origin without a path"
    exit 1
    ;;
esac

export INDEXER_API_URL="$indexer_api_url"

envsubst '${INDEXER_API_URL} ${AUTH_API_KEY}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

sed "s/\${INDEXER_API_URL}//g" \
  /usr/share/nginx/html/config.template.js \
  > /usr/share/nginx/html/config.js

exec "$@"
