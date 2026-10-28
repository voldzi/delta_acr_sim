# UNBUILT source candidate. Build locally only after reviewed dist compilation.
# No dependencies, environment, command, user, mounts or network are changed.
FROM sha256:4076069b3f8c935c0cd07ea2bf95d92703270b72197ff2b74a27d1aee8c6bdf0
COPY apps/simulator-api/dist/user-data.js /app/apps/simulator-api/dist/user-data.js
COPY packages/sim-user-data/bootstrap.mjs /app/packages/sim-user-data/bootstrap.mjs
COPY packages/sim-user-data/pg-errors.mjs /app/packages/sim-user-data/pg-errors.mjs
