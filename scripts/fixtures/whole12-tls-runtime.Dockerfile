# OFFLINE TEST BUNDLE ONLY. main-rootfs.tar is docker export of the exact
# immutable a337 main candidate; the other roots are separate exact /app copies.
# FROM scratch avoids contacting a registry from the isolated X5 builder.
FROM scratch
ADD main-rootfs.tar /
COPY router-app/ /runtime/router/
COPY situation-app/ /runtime/situation/
ENV NODE_ENV=production
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /app
USER 1000:1000
ENTRYPOINT ["node"]
