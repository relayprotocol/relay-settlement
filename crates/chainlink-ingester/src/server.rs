use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use alloy_primitives::B256;
use anyhow::{Context as _, Result};
use price_oracle_ipc::{
    BoundListener, HEARTBEAT_INTERVAL, IpcError, OracleFrame, OracleStream, PROTOCOL_VERSION,
    write_frame_with_timeout,
};
use tokio::io::{AsyncReadExt, AsyncWrite};
use tokio::sync::broadcast;
use tracing::{Instrument as _, Span, info, info_span, instrument, warn};

use crate::Context;
use crate::cache::{FeedCache, provider_id};
use crate::telemetry::TRACE_TARGET;

const MAX_SUBSCRIBERS: usize = 32;
const WRITE_TIMEOUT: Duration = HEARTBEAT_INTERVAL;

#[instrument(skip_all)]
pub async fn run(ctx: Context) -> Result<()> {
    let listener = BoundListener::bind(ctx.config.listen_address.clone())
        .await
        .context("failed to bind listener address")?;
    info!(address = %listener.address(), "listening for sequencer connections");

    let mut shutdown = ctx.shutdown.subscribe();
    loop {
        let stream = tokio::select! {
            biased;
            _ = shutdown.recv() => return Ok(()),
            result = listener.accept() => result.context("failed to accept connection")?,
        };

        let subscribers = ctx.cache.subscribers.fetch_add(1, Ordering::SeqCst) + 1;
        if subscribers > MAX_SUBSCRIBERS {
            ctx.cache.subscribers.fetch_sub(1, Ordering::SeqCst);
            warn!(
                max = MAX_SUBSCRIBERS,
                "rejecting sequencer connection, subscriber limit reached"
            );
            drop(stream);
            continue;
        }
        info!(subscribers, "sequencer subscriber connected");

        let cache = ctx.cache.clone();
        let feeds = ctx.config.feed_ids.clone();
        let shutdown = ctx.shutdown.subscribe();
        tokio::spawn(async move {
            match serve(stream, cache.clone(), feeds, shutdown).await {
                Ok(()) | Err(IpcError::Closed) => info!("sequencer subscriber disconnected"),
                Err(other) => warn!(error = %other, "subscriber connection ended with error"),
            }
            cache.subscribers.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

#[instrument(skip_all)]
async fn serve(
    stream: OracleStream,
    cache: Arc<FeedCache>,
    feeds: Vec<B256>,
    mut shutdown: broadcast::Receiver<()>,
) -> Result<(), IpcError> {
    let (mut read_half, mut write) = tokio::io::split(stream);

    let mut live = cache.live.subscribe();
    let snapshot = cache.snapshot();

    write_frame_with_timeout(
        &mut write,
        &OracleFrame::Hello {
            protocol_version: PROTOCOL_VERSION,
            provider_id: provider_id(),
            feeds,
        },
        WRITE_TIMEOUT,
    )
    .await?;
    for frame in &snapshot {
        write_frame_with_timeout(&mut write, frame, WRITE_TIMEOUT).await?;
    }

    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.tick().await;

    let mut discard = [0u8; 64];
    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => return Ok(()),
            _ = heartbeat.tick() => {
                write_frame_with_timeout(&mut write, &OracleFrame::Heartbeat, WRITE_TIMEOUT).await?;
            }
            res = read_half.read(&mut discard) => match res {
                Ok(0) => return Err(IpcError::Closed),
                Ok(_) => {
                    warn!("subscriber sent unexpected data, closing connection");
                    return Err(IpcError::Closed);
                }
                Err(e) => return Err(e.into()),
            },
            recv = live.recv() => match recv {
                Ok(frame) => {
                    let span = match &frame {
                        OracleFrame::PriceUpdate { feed_id, .. } => {
                            info_span!(target: TRACE_TARGET, "send", feed_id = %feed_id)
                        }
                        _ => Span::none(),
                    };
                    async {
                        write_frame_with_timeout(&mut write, &frame, WRITE_TIMEOUT).await?;
                        cache.sent.fetch_add(1, Ordering::Relaxed);
                        Ok::<(), IpcError>(())
                    }
                    .instrument(span)
                    .await?;
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(skipped = n, "subscriber lagged, resending snapshot");
                    send_snapshot(&mut write, &cache).await?;
                }
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            },
        }
    }
}

async fn send_snapshot<W>(write: &mut W, cache: &FeedCache) -> Result<(), IpcError>
where
    W: AsyncWrite + Unpin,
{
    for frame in &cache.snapshot() {
        write_frame_with_timeout(write, frame, WRITE_TIMEOUT).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::{CachedPrice, FeedKey};
    use price_oracle_ipc::{connect, read_frame};

    async fn spawn_server(cache: Arc<FeedCache>, shutdown: broadcast::Sender<()>) -> String {
        let listener = BoundListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.address().to_string();
        tokio::spawn(async move {
            while let Ok(stream) = listener.accept().await {
                let cache = cache.clone();
                let serve_shutdown = shutdown.subscribe();
                tokio::spawn(async move {
                    let _ =
                        serve(stream, cache, vec![B256::repeat_byte(0x03)], serve_shutdown).await;
                });
            }
        });
        address
    }

    #[tokio::test]
    async fn subscriber_receives_hello_first() {
        let cache = Arc::new(FeedCache::new());
        let (shutdown, _) = broadcast::channel(1);
        let address = spawn_server(cache, shutdown).await;

        let mut client = connect(&address).await.unwrap();
        let hello = read_frame(&mut client).await.unwrap();
        match hello {
            OracleFrame::Hello {
                protocol_version,
                provider_id: pid,
                ..
            } => {
                assert_eq!(protocol_version, PROTOCOL_VERSION);
                assert_eq!(pid, provider_id());
            }
            other => panic!("expected Hello, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn snapshot_replays_existing_payload_on_connect() {
        let cache = Arc::new(FeedCache::new());
        let (shutdown, _) = broadcast::channel(1);
        let key = FeedKey::new(provider_id(), B256::repeat_byte(0x03));
        cache.latest.lock().insert(
            key,
            CachedPrice {
                payload: vec![0xde, 0xad, 0xbe, 0xef],
                delivery_time_ms: 1_700_000_000_000,
                source_time_ms: 1_699_999_999_500,
            },
        );
        let address = spawn_server(cache, shutdown).await;

        let mut client = connect(&address).await.unwrap();
        let _hello = read_frame(&mut client).await.unwrap();
        let update = read_frame(&mut client).await.unwrap();
        assert_eq!(
            update,
            OracleFrame::PriceUpdate {
                feed_id: key.feed_id,
                payload: vec![0xde, 0xad, 0xbe, 0xef],
                source_time_ms: 1_699_999_999_500,
            }
        );
    }

    #[tokio::test]
    async fn multiple_subscribers_each_receive_updates() {
        let cache = Arc::new(FeedCache::new());
        let (shutdown, _) = broadcast::channel(1);
        let address = spawn_server(cache.clone(), shutdown).await;

        let mut first = connect(&address).await.unwrap();
        let mut second = connect(&address).await.unwrap();
        assert!(matches!(
            read_frame(&mut first).await.unwrap(),
            OracleFrame::Hello { .. }
        ));
        assert!(matches!(
            read_frame(&mut second).await.unwrap(),
            OracleFrame::Hello { .. }
        ));

        cache.live.send(OracleFrame::Heartbeat).unwrap();
        assert_eq!(
            read_frame(&mut first).await.unwrap(),
            OracleFrame::Heartbeat
        );
        assert_eq!(
            read_frame(&mut second).await.unwrap(),
            OracleFrame::Heartbeat
        );
    }
}
