FROM rust:1-bookworm AS builder
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p redstone-ingester

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV INGESTER_TRANSPORT=tcp
ENV INGESTER_SOCKET_ADDRESS=0.0.0.0:9803
EXPOSE 9803

COPY --from=builder /src/target/release/redstone-ingester /usr/local/bin/redstone-ingester

ENTRYPOINT ["/usr/local/bin/redstone-ingester"]
