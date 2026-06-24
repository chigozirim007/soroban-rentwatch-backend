FROM node:20-alpine AS base

# ─── Build Stage ───────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# ─── Runtime Stage ─────────────────────────────────────────
FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 rentwatch

# Copy built artifacts
COPY --from=builder --chown=rentwatch:nodejs /app/dist ./dist
COPY --from=builder --chown=rentwatch:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=rentwatch:nodejs /app/prisma ./prisma
COPY --from=builder --chown=rentwatch:nodejs /app/package.json ./

USER rentwatch

# Run Prisma migrations then start worker
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
