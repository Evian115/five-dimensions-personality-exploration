FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm test && npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5173 DATABASE_PATH=/app/data/bigfive.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/vendor ./vendor
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5173/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--experimental-strip-types", "server/index.ts"]
