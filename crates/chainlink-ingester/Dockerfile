FROM rust:1-bookworm AS builder
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p chainlink-ingester

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV INGESTER_ADDRESS=0.0.0.0:9801
EXPOSE 9801

COPY --from=builder /src/target/release/chainlink-ingester /usr/local/bin/chainlink-ingester

ENTRYPOINT ["/usr/local/bin/chainlink-ingester"]
