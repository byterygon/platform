# Mightyconsole container image (TSK-87): the static (musl) release binary with the UI built in,
# nothing else: no shell, no package manager, no CA bundle. Built by `release.mts image` from a
# staged context (the binary, LICENSE, README.md, THIRD-PARTY-NOTICES.txt and an empty data/);
# FROM scratch needs no base image, so building it fetches nothing.
FROM scratch
ARG VERSION
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Mightyconsole" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/byterygon/platform" \
      org.opencontainers.image.description="Offline web console for NATS, Kafka, Kubernetes, Temporal, Docker and LangGraph. Everyone signs in; the default administrator's password is in /data/admin-password."
COPY mightyconsole-server /mightyconsole-server
COPY LICENSE README.md THIRD-PARTY-NOTICES.txt /usr/share/doc/mightyconsole/
COPY --chown=65532:65532 data/ /data/
# The certificate is kept in /data (a volume, so it survives a new container).
ENV MIGHTYCONSOLE_DATA=/data
USER 65532:65532
VOLUME ["/data"]
EXPOSE 7443
ENTRYPOINT ["/mightyconsole-server"]
# All of the container's addresses. Everyone signs in (built-in accounts or OIDC); the
# certificate is self-signed unless --tls-cert and --tls-key are given, so publish the port on
# the host's 127.0.0.1 only (docker run -p 127.0.0.1:7443:7443 ...) until you have one.
CMD ["serve", "--listen", "0.0.0.0:7443"]
