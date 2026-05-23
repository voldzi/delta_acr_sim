FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json ./
COPY docs ./docs
COPY packages ./packages
COPY apps/simulator-api ./apps/simulator-api
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @csm-sim/simulator-api... build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/docs ./docs
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/simulator-api ./apps/simulator-api
RUN pnpm install --prod --frozen-lockfile
EXPOSE 4000
CMD ["node", "apps/simulator-api/dist/index.js"]
