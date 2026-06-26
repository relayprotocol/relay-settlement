use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use alloy_primitives::B256;
use anyhow::{Context as _, Result};
use price_oracle_ipc::{
    BoundListener, IpcError, OracleFrame, OracleStream, PROTOCOL_VERSION, write_frame_with_timeout,
};
use tokio::io::{AsyncReadExt, AsyncWrite};
use tokio::sync::broadcast;
use tracing::{Instrument as _, Span, info, info_span, instrument, warn};

use crate::Context;
use crate::cache::{FeedCache, now_unix, provider_id};
use crate::telemetry::TRACE_TARGET;

#[instrument(skip_all)]
pub async fn run(ctx: Context) -> Result<()> {
    let listener = BoundListener::bind(ctx.config.listen_endpoint.clone())
        .await
        .context("failed to bind listener endpoint")?;
    info!(endpoint = %listener.endpoint(), "listening for sequencer connections");

    let mut shutdown = ctx.shutdown.subscribe();
    loop {
        let stream = tokio::select! {
            biased;
            _ = shutdown.recv() => return Ok(()),
            result = listener.accept() => result.context("failed to accept connection")?,
        };

        if ctx.cache.subscriber_connected.swap(true, Ordering::SeqCst) {
            warn!("rejecting sequencer connection, a subscriber is already connected");
            drop(stream);
            continue;
        }
        info!("sequencer subscriber connected");

        let cache = ctx.cache.clone();
        let feeds = ctx.config.feed_ids.clone();
        let heartbeat = ctx.config.heartbeat_interval;
        let write_timeout = ctx.config.write_timeout;
        let shutdown = ctx.shutdown.subscribe();
        tokio::spawn(async move {
            match serve(
                stream,
                cache.clone(),
                feeds,
                heartbeat,
                write_timeout,
                shutdown,
            )
            .await
            {
                Ok(()) | Err(IpcError::Closed) => info!("sequencer subscriber disconnected"),
                Err(other) => warn!(error = %other, "subscriber connection ended with error"),
            }
            cache.subscriber_connected.store(false, Ordering::SeqCst);
        });
    }
}

#[instrument(skip_all)]
async fn serve(
    stream: OracleStream,
    cache: Arc<FeedCache>,
    feeds: Vec<B256>,
    heartbeat_interval: Duration,
    write_timeout: Duration,
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
            heartbeat_interval_sec: heartbeat_interval.as_secs() as u32,
        },
        write_timeout,
    )
    .await?;
    for frame in &snapshot {
        write_frame_with_timeout(&mut write, frame, write_timeout).await?;
    }

    let mut heartbeat = tokio::time::interval(heartbeat_interval);
    heartbeat.tick().await;

    let mut discard = [0u8; 64];
    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => return Ok(()),
            _ = heartbeat.tick() => {
                write_frame_with_timeout(&mut write, &OracleFrame::Heartbeat { sent_at_unix: now_unix() }, write_timeout).await?;
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
                        write_frame_with_timeout(&mut write, &frame, write_timeout).await?;
                        cache.sent.fetch_add(1, Ordering::Relaxed);
                        Ok::<(), IpcError>(())
                    }
                    .instrument(span)
                    .await?;
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(skipped = n, "subscriber lagged, resending snapshot");
                    send_snapshot(&mut write, &cache, write_timeout).await?;
                }
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            },
        }
    }
}

async fn send_snapshot<W>(
    write: &mut W,
    cache: &FeedCache,
    write_timeout: Duration,
) -> Result<(), IpcError>
where
    W: AsyncWrite + Unpin,
{
    for frame in &cache.snapshot() {
        write_frame_with_timeout(write, frame, write_timeout).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use super::*;
    use crate::cache::FeedKey;
    use price_oracle_ipc::{Endpoint, connect, read_frame};

    #[tokio::test]
    async fn subscriber_receives_hello_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("svc.sock");

        let cache = Arc::new(FeedCache::new());
        let (shutdown, _) = broadcast::channel(1);
        let listener = BoundListener::bind(Endpoint::unix(path.clone()))
            .await
            .unwrap();

        let serve_cache = cache.clone();
        let serve_shutdown = shutdown.subscribe();
        tokio::spawn(async move {
            let stream = listener.accept().await.unwrap();
            let _ = serve(
                stream,
                serve_cache,
                vec![B256::repeat_byte(0x03)],
                Duration::from_secs(60),
                Duration::from_secs(60),
                serve_shutdown,
            )
            .await;
        });

        let mut client = connect(&Endpoint::unix(path.clone())).await.unwrap();
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
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("svc.sock");

        let cache = Arc::new(FeedCache::new());
        let (shutdown, _) = broadcast::channel(1);
        let key = FeedKey::new(provider_id(), B256::repeat_byte(0x03));
        cache
            .latest
            .lock()
            .insert(key, (vec![0xde, 0xad, 0xbe, 0xef], 1_700_000_000));

        let listener = BoundListener::bind(Endpoint::unix(path.clone()))
            .await
            .unwrap();
        let serve_cache = cache.clone();
        let serve_shutdown = shutdown.subscribe();
        tokio::spawn(async move {
            let stream = listener.accept().await.unwrap();
            let _ = serve(
                stream,
                serve_cache,
                vec![],
                Duration::from_secs(60),
                Duration::from_secs(60),
                serve_shutdown,
            )
            .await;
        });

        let mut client = connect(&Endpoint::unix(path.clone())).await.unwrap();
        let _hello = read_frame(&mut client).await.unwrap();
        let update = read_frame(&mut client).await.unwrap();
        assert_eq!(
            update,
            OracleFrame::PriceUpdate {
                provider_id: key.provider_id,
                feed_id: key.feed_id,
                payload: vec![0xde, 0xad, 0xbe, 0xef],
                ingested_at: 1_700_000_000,
            }
        );
    }

    #[tokio::test]
    async fn second_subscriber_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("svc.sock");

        let cache = Arc::new(FeedCache::new());
        let (shutdown, _) = broadcast::channel(1);
        let listener = BoundListener::bind(Endpoint::unix(path.clone()))
            .await
            .unwrap();
        let busy = Arc::new(AtomicBool::new(false));

        let accept_cache = cache.clone();
        let accept_busy = busy.clone();
        let accept_shutdown = shutdown.clone();
        tokio::spawn(async move {
            loop {
                let stream = listener.accept().await.unwrap();
                if accept_busy.swap(true, Ordering::SeqCst) {
                    drop(stream);
                    continue;
                }
                let cache = accept_cache.clone();
                let busy = accept_busy.clone();
                let serve_shutdown = accept_shutdown.subscribe();
                tokio::spawn(async move {
                    let _ = serve(
                        stream,
                        cache,
                        vec![],
                        Duration::from_secs(60),
                        Duration::from_secs(60),
                        serve_shutdown,
                    )
                    .await;
                    busy.store(false, Ordering::SeqCst);
                });
            }
        });

        let mut first = connect(&Endpoint::unix(path.clone())).await.unwrap();
        let _ = read_frame(&mut first).await.unwrap();

        let mut second = connect(&Endpoint::unix(path.clone())).await.unwrap();
        assert!(matches!(
            read_frame(&mut second).await,
            Err(IpcError::Closed)
        ));
        cache
            .live
            .send(OracleFrame::Heartbeat { sent_at_unix: 1 })
            .unwrap();
        assert_eq!(
            read_frame(&mut first).await.unwrap(),
            OracleFrame::Heartbeat { sent_at_unix: 1 }
        );
    }
}
