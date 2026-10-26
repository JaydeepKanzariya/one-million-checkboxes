FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000

USER node
CMD ["node", "server/index.js"]

