FROM node:20-alpine AS frontend-build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html styles.css ./
COPY public ./public
COPY src ./src

ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM node:20-alpine AS backend-build
WORKDIR /app
RUN apk add --no-cache openssl

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/prisma ./prisma
RUN npx prisma generate

COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
# The Dokploy domain (watchora.ramagiritharun.in) maps to container port
# 3000; the server reads PORT at boot. Change here if the domain port changes.
ENV PORT=3000

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/prisma ./prisma
RUN npx prisma generate

COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/dist ./public-web

EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
