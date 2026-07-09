# SMS/Call router — production image.
FROM node:22-slim

# Prisma needs openssl at runtime.
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps (cached layer).
COPY package.json package-lock.json ./
RUN npm ci

# App source.
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Generate the Prisma client at build time.
RUN npx prisma generate

ENV NODE_ENV=production
EXPOSE 3000

# On boot: apply the schema to the database, then start the server.
# (db push is idempotent; safe to run every start.)
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && npx tsx src/index.ts"]
