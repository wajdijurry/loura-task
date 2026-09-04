# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 loura \
  && useradd --system --uid 1001 --gid loura --home-dir /app --shell /usr/sbin/nologin loura
COPY --from=build --chown=loura:loura /app/package.json /app/package-lock.json ./
COPY --from=build --chown=loura:loura /app/node_modules ./node_modules
COPY --from=build --chown=loura:loura /app/dist ./dist
COPY --from=build --chown=loura:loura /app/migrations ./migrations
COPY --chown=loura:loura data ./data
COPY --chown=loura:loura scripts ./scripts
USER loura
EXPOSE 3000
CMD ["node", "dist/api/main.js"]
