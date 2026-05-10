# ──────────────────────────────────────────────────────────────
# PlanBuddy Backend — Production Dockerfile
# Multi-stage build: installs deps in builder, copies to lean runner
# ──────────────────────────────────────────────────────────────

# ─── Stage 1: Dependencies ────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy package files only (for layer caching)
COPY package*.json ./

# Install production deps only
RUN npm ci --only=production && npm cache clean --force

# ─── Stage 2: Production image ────────────────────────────────
FROM node:20-alpine AS runner

# Security: run as non-root
RUN addgroup -S planbuddy && adduser -S planbuddy -G planbuddy

WORKDIR /app

# Copy deps from builder stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY --chown=planbuddy:planbuddy . .

# Create logs directory
RUN mkdir -p /app/logs && chown planbuddy:planbuddy /app/logs

# Don't run as root
USER planbuddy

# Make start.sh executable
RUN chmod +x start.sh

# Expose port
EXPOSE 3000

# Healthcheck - DB + Redis
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node scripts/healthcheck.js

# Production startup: migrations then server
CMD ["./start.sh"]

