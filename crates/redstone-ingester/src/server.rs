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
