# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/backend apps/backend

RUN npm run db:generate
RUN npm run build --workspace=@kda/db
RUN npm run build --workspace=@kda/shared
RUN npm run build --workspace=@kda/backend
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
RUN apk add --no-cache openssl

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/apps/backend/package.json apps/backend/package.json
COPY --from=build /app/apps/backend/dist apps/backend/dist
COPY --from=build /app/packages/db/package.json packages/db/package.json
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/prisma packages/db/prisma
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist

EXPOSE 3001
CMD ["node", "apps/backend/dist/index.js"]
