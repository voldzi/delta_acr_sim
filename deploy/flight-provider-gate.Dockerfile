ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY sources.js provider-request-gate.js /app/apps/flight-data-api/dist/
