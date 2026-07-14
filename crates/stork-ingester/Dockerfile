FROM rust:1-bookworm AS builder
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p stork-ingester

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV INGESTER_ADDRESS=0.0.0.0:9804
EXPOSE 9804

COPY --from=builder /src/target/release/stork-ingester /usr/local/bin/stork-ingester

ENTRYPOINT ["/usr/local/bin/stork-ingester"]
