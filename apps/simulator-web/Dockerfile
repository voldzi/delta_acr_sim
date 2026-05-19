FROM node:24-alpine AS build
ARG VITE_COP_DISPLAY_URL=https://cop.zeleznalady.cz
ENV VITE_COP_DISPLAY_URL=$VITE_COP_DISPLAY_URL
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/simulator-web ./apps/simulator-web
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @delta-acr/simulator-web build

FROM nginx:1.29-alpine AS runtime
COPY apps/simulator-web/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/simulator-web/dist /usr/share/nginx/html
EXPOSE 80
