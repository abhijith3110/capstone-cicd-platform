FROM node:20-alpine AS builder
WORKDIR /app
COPY src ./src
RUN mkdir -p /app/dist && cp -r src/* /app/dist/

FROM nginx:1.27-alpine AS runtime

RUN apk add --no-cache curl && \
    addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh && \
    chown -R appuser:appgroup /usr/share/nginx/html /var/cache/nginx /var/run

USER appuser
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
