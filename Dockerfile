FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM build AS runtime-dependencies
RUN npm prune --omit=dev

FROM nginx:1.30.6-alpine AS edge
COPY --from=build /app/dist /srv/staffly

FROM node:24-bookworm-slim AS file-processor
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=runtime-dependencies /app/node_modules ./node_modules
COPY --from=build /app/src/server/file-processing ./src/server/file-processing
COPY --from=build /app/src/server/file-preview ./src/server/file-preview
COPY --from=build /app/src/server/documents/office-validation.ts ./src/server/documents/office-validation.ts
COPY --from=build /app/src/server/api-error.ts ./src/server/api-error.ts
COPY --from=build /app/src/app/file-preview ./src/app/file-preview
RUN mkdir -p /run/file-processor && chown node:node /run/file-processor && chmod 700 /run/file-processor
USER node
CMD ["node", "--max-old-space-size=192", "src/server/file-processing/server.ts"]

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=runtime-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma7.config.ts ./prisma7.config.ts
RUN mkdir -p /var/lib/staffly/storage && chown node:node /var/lib/staffly/storage
USER node
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/server/index.ts"]

# Operator image: PostgreSQL client matches the database major version.
# It receives its own credentials and separate persistent backup volumes.
FROM postgres:18 AS maintenance
WORKDIR /app
RUN useradd --uid 1000 --create-home node && mkdir -p /var/lib/staffly/database-backups /var/lib/staffly/file-backups /var/lib/staffly/deletion-ledger && chown -R node:node /var/lib/staffly
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime --chown=node:node /app /app
COPY --from=build --chown=node:node /app/scripts ./scripts
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "--import", "tsx"]
CMD ["scripts/admin-maintenance.ts", "--watch"]

FROM runtime AS observer
COPY --from=build --chown=node:node /app/scripts ./scripts
USER root
RUN mkdir -p /var/lib/staffly/observer && chown node:node /var/lib/staffly/observer
USER node
CMD ["node", "--import", "tsx", "scripts/service-observer.ts", "--watch"]

# Keep the default build equivalent to the HTTP application image.
FROM runtime AS production
