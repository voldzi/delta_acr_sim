FROM node:24-alpine AS build
ARG VITE_COP_DISPLAY_URL=https://cop.zeleznalady.cz
ARG VITE_SIM_AUTH_MODE=token
ARG VITE_SIM_OIDC_ISSUER=
ARG VITE_SIM_OIDC_CLIENT_ID=csm-sim-web
ARG VITE_SIM_OIDC_SCOPE="openid profile email"
ARG VITE_SIM_PUBLIC_READ_ENABLED=false
ARG VITE_SIM_ALLOW_TOKEN_LOGIN=false
ENV VITE_COP_DISPLAY_URL=$VITE_COP_DISPLAY_URL
ENV VITE_SIM_AUTH_MODE=$VITE_SIM_AUTH_MODE
ENV VITE_SIM_OIDC_ISSUER=$VITE_SIM_OIDC_ISSUER
ENV VITE_SIM_OIDC_CLIENT_ID=$VITE_SIM_OIDC_CLIENT_ID
ENV VITE_SIM_OIDC_SCOPE=$VITE_SIM_OIDC_SCOPE
ENV VITE_SIM_PUBLIC_READ_ENABLED=$VITE_SIM_PUBLIC_READ_ENABLED
ENV VITE_SIM_ALLOW_TOKEN_LOGIN=$VITE_SIM_ALLOW_TOKEN_LOGIN
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/simulator-web ./apps/simulator-web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @csm-sim/simulator-web build

FROM nginx:1.29-alpine AS runtime
RUN mkdir -p /etc/nginx/includes
COPY apps/simulator-web/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY apps/simulator-web/nginx/internal-provider-access.conf /etc/nginx/includes/internal-provider-access.conf
COPY apps/simulator-web/nginx/provider-cache.conf /etc/nginx/includes/provider-cache.conf
COPY apps/simulator-web/nginx/security-headers.conf /etc/nginx/includes/security-headers.conf
COPY --from=build /app/apps/simulator-web/dist /usr/share/nginx/html
RUN chmod -R a+rX /usr/share/nginx/html
EXPOSE 80
