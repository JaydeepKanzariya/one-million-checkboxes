# Stage 1: build the React client (needs dev dependencies: Vite and the React plugin).
FROM node:22-alpine AS client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
RUN npm run build

# Stage 2: the server, plus the built client. No dev dependencies at runtime.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY --from=client /app/client/dist ./client/dist

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

USER node
CMD ["node", "server/index.js"]
