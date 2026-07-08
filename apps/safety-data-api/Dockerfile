FROM node:24-alpine AS build
WORKDIR /app
COPY .corepack-pnpm-10.33.0.tgz /tmp/corepack-pnpm-10.33.0.tgz
RUN corepack enable && corepack install -g /tmp/corepack-pnpm-10.33.0.tgz && rm /tmp/corepack-pnpm-10.33.0.tgz

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/observability ./packages/observability
COPY apps/safety-data-api ./apps/safety-data-api
RUN --mount=type=cache,id=csm-sim-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked pnpm install --frozen-lockfile
RUN pnpm --filter @csm-sim/safety-data-api... build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY .corepack-pnpm-10.33.0.tgz /tmp/corepack-pnpm-10.33.0.tgz
RUN corepack enable && corepack install -g /tmp/corepack-pnpm-10.33.0.tgz && rm /tmp/corepack-pnpm-10.33.0.tgz
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=build /app/packages/observability ./packages/observability
COPY --from=build /app/apps/safety-data-api ./apps/safety-data-api
RUN --mount=type=cache,id=csm-sim-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked pnpm install --prod --frozen-lockfile
EXPOSE 4030
CMD ["node", "apps/safety-data-api/dist/index.js"]
