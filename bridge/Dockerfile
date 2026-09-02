# syntax=docker/dockerfile:1
# cookbook-crew-bridge (Node.js thin bridge — migrated out of CADS-Tunnel core, see #219): the HTTP
# server + wire-format assembly (server.js/server.lib.js) is plain Node with zero dependencies. It
# still needs the `ct-agent` CLI to actually dial role channels.
#
# ct-agent's source was extracted out of CADS-Tunnel core into its own repo (scimbe/ct-agent) --
# building it from a sibling CADS-Tunnel checkout (the old `tunnel-src` additional build context)
# stopped working once that extraction landed (crates/agent no longer exists there at all, so
# `cargo build --bin ct-agent` fails outright). Same fix already applied to CADS-flappy-demo's
# bridge/Dockerfile and to this repo's own Agent.Dockerfile: clone scimbe/ct-agent directly at a
# pinned ref instead.
#
# Two stages: compile just the one binary this service needs, then ship it next to the Node
# server in a lean runtime image. Cached the same way as core's own Dockerfile (BuildKit cache
# mounts for the cargo registry + target/) — needs BuildKit/buildx.
#
# Runtime MUST be glibc, matching the -bookworm builder (same rule as core's own Dockerfile,
# #165, and flappy-demo's equivalent bridge): node:*-alpine is musl-based, and a glibc-linked
# ct-agent silently fails to exec there ("not found", not an obvious linker error) — node:*-slim
# (Debian) keeps both stages on glibc.

FROM rust:1-slim-bookworm AS ctagent-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
# Which ct-agent commit to build -- bump deliberately, matching this repo's own Agent.Dockerfile
# pin. Was pinned at v0.4.8 since 2026-08-13 (CADS-Tunnel#494 admission-timeout fix). Bumped to
# v0.5.7 on 2026-09-02 to match CADS-a2a-demo/CADS-auction-demo, which had already moved ahead --
# cookbook was the one demo left on the older line. Keep in sync with Agent.Dockerfile's own
# CT_AGENT_REF.
ARG CT_AGENT_REF=v0.5.7
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
    && cp target/release/ct-agent /build/ct-agent

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ctagent-builder /build/ct-agent /usr/local/bin/ct-agent
WORKDIR /srv
COPY bridge/server.js bridge/server.lib.js ./
EXPOSE 8789
CMD ["node", "server.js"]
