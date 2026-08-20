FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

ENV NODE_ENV=production
WORKDIR /app

RUN chown node:node /app
USER node

COPY --chown=node:node infra/hatchet/worker/package.json infra/hatchet/worker/package-lock.json ./
RUN npm ci --include=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node lib/orchestration ./lib/orchestration
COPY --chown=node:node scripts/hatchet ./scripts/hatchet

CMD ["./node_modules/.bin/tsx", "scripts/hatchet/worker.ts"]
