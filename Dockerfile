# Relay only (the page itself is static and lives on Vercel).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY config ./config
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server/relay.mjs"]
