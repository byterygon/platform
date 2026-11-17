# Mightyconsole container image (TSK-87): the static (musl) release binary with the UI built in,
# nothing else: no shell, no package manager, no CA bundle. Built by `release.mts image` from a
# staged context (the binary, LICENSE, README.md, THIRD-PARTY-NOTICES.txt and an empty data/);
# FROM scratch needs no base image, so building it fetches nothing.
FROM scratch
ARG VERSION
LABEL org.opencontainers.image.title="Mightyconsole" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/byterygon/platform" \
      org.opencontainers.image.description="Offline web console for NATS, Kafka, Kubernetes, Temporal, Docker over SSH and LangGraph. No login: publish it on 127.0.0.1 only."
COPY mightyconsole-server /mightyconsole-server
COPY LICENSE README.md THIRD-PARTY-NOTICES.txt /usr/share/doc/mightyconsole/
COPY --chown=65532:65532 data/ /data/
# The certificate is kept in /data (a volume, so it survives a new container).
ENV MIGHTYCONSOLE_DATA=/data
USER 65532:65532
VOLUME ["/data"]
EXPOSE 7443
ENTRYPOINT ["/mightyconsole-server"]
# All of the container's addresses: publish the port on the host's 127.0.0.1 only
# (docker run -p 127.0.0.1:7443:7443 ...); there is no login.
CMD ["serve", "--listen", "0.0.0.0:7443"]
