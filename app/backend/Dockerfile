FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm test -- --ci

FROM node:20-alpine AS prod-deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --chown=appuser:appgroup src ./src
COPY --chown=appuser:appgroup package*.json ./

ARG BUILD_NUMBER=local
ARG APP_VERSION=dev
ENV BUILD_NUMBER=${BUILD_NUMBER}
ENV APP_VERSION=${APP_VERSION}

USER appuser
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health/live', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
