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

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=runtime-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma7.config.ts ./prisma7.config.ts
USER node
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/server/index.ts"]
