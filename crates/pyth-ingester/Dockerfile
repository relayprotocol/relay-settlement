FROM rust:1-bookworm AS builder
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p pyth-ingester

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV INGESTER_ADDRESS=0.0.0.0:9802
EXPOSE 9802

COPY --from=builder /src/target/release/pyth-ingester /usr/local/bin/pyth-ingester

ENTRYPOINT ["/usr/local/bin/pyth-ingester"]
