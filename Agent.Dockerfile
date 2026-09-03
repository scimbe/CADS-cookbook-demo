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
# Was pinned at v0.4.8 since 2026-08-13 (admission-stall fix, CADS-Tunnel#494).
# Bumped to v0.5.7 on 2026-09-02 to match CADS-a2a-demo/CADS-auction-demo,
# which had already moved ahead -- cookbook was the one demo left on the
# older line. Keep in sync with bridge/Dockerfile's own CT_AGENT_REF.
ARG CT_AGENT_REF=v0.7.24
# Optional gh-token secret (--secret id=gh_token,src=<file>): GitHub's anonymous
# git-clone rate limit for this host's IP was hit 2026-09-02 (anonymous curl/DNS
# still worked, only the git smart-HTTP clone got an auth challenge) -- falls
# back to a plain anonymous clone when no secret is passed, so this stays a
# no-op for anyone building without a token.
RUN --mount=type=secret,id=gh_token \
    if [ -s /run/secrets/gh_token ]; then \
      git -c http.https://github.com/.extraheader="AUTHORIZATION: basic $(printf 'x:%s' "$(cat /run/secrets/gh_token)" | base64 -w0)" clone https://github.com/scimbe/ct-agent.git /build; \
    else \
      git clone https://github.com/scimbe/ct-agent.git /build; \
    fi \
    && cd /build && git checkout "${CT_AGENT_REF}"
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
