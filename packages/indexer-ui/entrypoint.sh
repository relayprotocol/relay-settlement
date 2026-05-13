#!/bin/sh
set -eu

indexer_api_url=$(printf '%s' "${INDEXER_API_URL:-}" | sed 's/[\/&]/\\&/g')
sed "s/\${INDEXER_API_URL}/$indexer_api_url/g" \
  /usr/share/nginx/html/config.template.js \
  > /usr/share/nginx/html/config.js

exec "$@"
