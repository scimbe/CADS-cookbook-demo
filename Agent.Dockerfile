# The Browser-Plane agent for this demo (SNI passthrough) -- built from the
# standalone scimbe/ct-agent repo, same shape as bridge/Dockerfile's own
# ctagent-builder stage and CADS-webconference-demo/Agent.Dockerfile.
#
# compose.cookbook-demo.yml's cookbook-agent service previously built from a
# sibling CADS-Tunnel checkout (context: ${CT_TUNNEL_SRC}, dockerfile:
# docker/Dockerfile, args: CRATE=ct-agent) -- that stopped working once
# ct-agent's source was extracted out of CADS-Tunnel core into its own repo
# (see docker/Dockerfile's own header comment there: "The native ct-agent
# binary itself was extracted to its own repo ... and is NOT built here").
# crates/agent no longer exists in that checkout at all, so the old build
# path would silently produce an image with no ct-agent binary in it -- the
# container that had been running for days only worked because its image
# predated the extraction. Switched to this dedicated Dockerfile (same fix
# already applied to CADS-flappy-demo's Agent.Dockerfile/bridge/Dockerfile)
# so a fresh build actually works.

FROM rust:1-slim-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
# Bumped 2026-08-13 (v0.4.8): THE actual root cause of the admission-stall
# saga (CADS-Tunnel#494), pinned by the operator via live edge logs -- the
# edge parks a lone first pairing member for a 30s TTL waiting for its
# partner, but the CLIENT's own ADMISSION_EXCHANGE_TIMEOUT was only 15s.
# v0.4.8 raises it to 45s. Keep in sync with bridge/Dockerfile's own
# CT_AGENT_REF, and with CADS-flappy-demo/CADS-webconference-demo/
# CADS-auction-demo's own Agent.Dockerfile pins.
ARG CT_AGENT_REF=3823343fdc47ea4ed91819cb68bfa8e89399f3f8
RUN git clone https://github.com/scimbe/ct-agent.git /build && cd /build && git checkout "${CT_AGENT_REF}"
WORKDIR /build
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked -p ct-agent \
    && cp target/release/ct-agent /tmp/ct-agent

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /tmp/ct-agent /usr/local/bin/ct-agent
CMD ["ct-agent"]
