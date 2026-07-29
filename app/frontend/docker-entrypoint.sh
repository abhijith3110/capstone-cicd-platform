#!/bin/sh
set -e

cat <<EOF > /usr/share/nginx/html/env.js
window.__ENV__ = {
  API_BASE_URL: "${API_BASE_URL:-/api}"
};
EOF

exec nginx -g 'daemon off;'
