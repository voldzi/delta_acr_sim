FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/observability ./packages/observability
COPY apps/situation-data-api ./apps/situation-data-api
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @csm-sim/situation-data-api... build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/observability ./packages/observability
COPY --from=build /app/apps/situation-data-api ./apps/situation-data-api
RUN pnpm install --prod --frozen-lockfile
EXPOSE 4020
CMD ["node", "apps/situation-data-api/dist/index.js"]
