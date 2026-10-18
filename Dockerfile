# Production Dockerfile for LabPulse (Module 17: Production Infrastructure)
FROM node:20-alpine AS builder

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Set container ownership to non-root node user
RUN chown -R node:node /app

# Switch to non-root user for principle of least privilege
USER node

# Expose standard application port
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV JWT_ACCESS_SECRET=labpulse_access_secret_c1f4e892d9a3b47c89f01e23a45b67c8d9e0f123456789abcdef0123456789ab
ENV JWT_REFRESH_SECRET=labpulse_refresh_secret_e7b8a912c34567890abcdef1234567890abcdef1234567890abcdef1234567890
ENV DATA_BACKEND=mongodb

# Container liveness healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/liveness').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
