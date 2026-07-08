FROM node:24-alpine AS build
WORKDIR /app
COPY .corepack-pnpm-10.33.0.tgz /tmp/corepack-pnpm-10.33.0.tgz
RUN corepack enable && corepack install -g /tmp/corepack-pnpm-10.33.0.tgz && rm /tmp/corepack-pnpm-10.33.0.tgz

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY docs ./docs
COPY packages ./packages
COPY apps/simulator-api ./apps/simulator-api
RUN --mount=type=cache,id=csm-sim-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked pnpm install --frozen-lockfile
RUN pnpm --filter @csm-sim/simulator-api... build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY .corepack-pnpm-10.33.0.tgz /tmp/corepack-pnpm-10.33.0.tgz
RUN corepack enable && corepack install -g /tmp/corepack-pnpm-10.33.0.tgz && rm /tmp/corepack-pnpm-10.33.0.tgz
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=build /app/docs ./docs
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/simulator-api ./apps/simulator-api
RUN --mount=type=cache,id=csm-sim-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked pnpm install --prod --frozen-lockfile
EXPOSE 4000
CMD ["node", "apps/simulator-api/dist/index.js"]
