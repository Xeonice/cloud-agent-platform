# Override this with the running CAP version, for example:
#   --build-arg CAP_VERSION=v0.31.0
ARG CAP_VERSION=v0.0.0
FROM ghcr.io/xeonice/cap-boxlite-sandbox:${CAP_VERSION}

USER root

# Install tools that every BoxLite task in this environment should see.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    jq \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN node /usr/local/bin/write-sandbox-metadata.mjs \
  --from /etc/cap/sandbox-metadata.json \
  --dependency "jq=$(jq --version)" \
  --dependency "ripgrep=$(rg --version | head -1 | awk '{print $2}')" \
  --output /etc/cap/sandbox-metadata.json

USER gem
WORKDIR /home/gem/workspace
