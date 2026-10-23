ARG BASE_IMAGE
FROM ${BASE_IMAGE}
LABEL org.opencontainers.image.revision="dd3a75b"
COPY routing-service.js user-selected-arrival.js /app/apps/situation-data-api/dist/
COPY user-selected-arrival-v1.schemas.json /app/openapi/fragments/
