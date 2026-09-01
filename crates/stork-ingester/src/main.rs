mod cache;
mod config;
mod ingester;
mod metrics;
mod payload;
mod server;
mod taxonomy;
mod telemetry;
mod verification;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context as _, Result, anyhow};
use rustls::crypto::ring;
use tokio::signal::ctrl_c;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::broadcast;
use tokio::time::{Duration, interval, sleep};
use tracing::{Instrument as _, error, info, info_span, instrument, warn};

use crate::cache::FeedCache;
use crate::config::Config;
use crate::taxonomy::FeedSet;

const REPORT_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct Context {
    pub shutdown: broadcast::Sender<()>,
    pub config: Arc<Config>,
    pub cache: Arc<FeedCache>,
    pub sockets: Arc<AtomicUsize>,
    pub feeds: Arc<FeedSet>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();

    let config = Arc::new(config::get()?);
    let providers = telemetry::init(config.telemetry.as_ref())?;

    let startup = info_span!(target: telemetry::TRACE_TARGET, "startup");
    let ctx = async {
        ring::default_provider()
            .install_default()
            .map_err(|_| anyhow!("failed to install rustls ring crypto provider"))?;

        if let Some(telemetry) = config.telemetry.as_ref() {
            telemetry::probe(telemetry).await;
        }

        let feeds = Arc::new(resolve_feeds(config.as_ref()).await?);

        let (shutdown, _) = broadcast::channel::<()>(1);
        let ctx = Context {
            shutdown,
            config,
            cache: Arc::new(FeedCache::new()),
            sockets: Arc::new(AtomicUsize::new(0)),
            feeds,
        };
        metrics::init(ctx.feeds.as_ref(), ctx.sockets.clone(), ctx.cache.clone());
        Ok::<_, anyhow::Error>(ctx)
    }
    .instrument(startup)
    .await?;

    tokio::select! {
        biased;
        result = tokio::spawn(handle_interrupt()) => {
            warn!("interrupt handler exited");
            match result {
                Err(e) => error!("failed to launch interrupt handler task: {:#}", e),
                Ok(Err(e)) => error!("interrupt handler failed: {:#}", e),
                _ => {}
            }
            notify_shutdown(&ctx).await?;
        },
        result = tokio::spawn(run_ingester(ctx.clone())) => {
            warn!("ingester stopped");
            match result {
                Err(e) => error!("failed to launch ingester task: {:#}", e),
                Ok(Err(e)) => error!("ingester error: {:#}", e),
                _ => {}
            }
            notify_shutdown(&ctx).await?;
        },
        result = tokio::spawn(run_listener(ctx.clone())) => {
            warn!("listener stopped");
            match result {
                Err(e) => error!("failed to launch listener task: {:#}", e),
                Ok(Err(e)) => error!("listener error: {:#}", e),
                _ => {}
            }
            notify_shutdown(&ctx).await?;
        },
        result = tokio::spawn(run_reporter(ctx.clone())) => {
            warn!("reporter stopped");
            match result {
                Err(e) => error!("failed to launch reporter task: {:#}", e),
                Ok(Err(e)) => error!("reporter error: {:#}", e),
                _ => {}
            }
            notify_shutdown(&ctx).await?;
        },
    }

    if let Some(providers) = providers {
        providers.shutdown();
    }
    Ok(())
}

#[instrument(skip_all)]
async fn handle_interrupt() -> Result<()> {
    let sigint = ctrl_c();
    let mut sigterm = signal(SignalKind::terminate())?;

    tokio::select! {
        _ = sigint => info!("received SIGINT signal, exiting"),
        _ = sigterm.recv() => info!("received SIGTERM signal, exiting"),
    }
    Ok(())
}

#[instrument(skip_all)]
async fn resolve_feeds(config: &Config) -> Result<FeedSet> {
    let mut attempt = 1;
    let response = loop {
        match taxonomy::fetch(&config.ws_endpoint, &config.auth_token).await {
            Ok(response) => break response,
            Err(err) if attempt < taxonomy::MAX_ATTEMPTS => {
                warn!(attempt, "taxonomy fetch failed, retrying: {err:#}");
                sleep(taxonomy::RETRY_BACKOFF).await;
                attempt += 1;
            }
            Err(err) => return Err(err.context("failed to fetch Stork taxonomy")),
        }
    };

    let feeds = taxonomy::validate(config.taxonomy_id, &config.feeds, response)
        .context("configured feeds do not match the Stork taxonomy")?;
    info!(
        taxonomy_id = feeds.taxonomy_id,
        feeds = feeds.assets.len(),
        "validated configured feeds against taxonomy"
    );
    Ok(feeds)
}

#[instrument(skip_all)]
async fn notify_shutdown(ctx: &Context) -> Result<()> {
    if ctx.shutdown.receiver_count() > 0 {
        info!("sending shutdown signal to all tasks");
        ctx.shutdown.send(())?;
        info!("waiting 3 sec for graceful shutdown");
        sleep(Duration::from_secs(3)).await;
    }
    Ok(())
}

#[instrument(skip_all)]
async fn run_ingester(ctx: Context) -> Result<()> {
    let mut shutdown = ctx.shutdown.subscribe();

    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => {
                info!("ingester received shutdown signal");
                return Ok(());
            },
            result = ingester::run(ctx.clone()) => match result {
                Ok(()) => return Ok(()),
                Err(err) => {
                    error!("restarting ingester: {err:#}");
                    sleep(Duration::from_secs(1)).await;
                }
            },
        }
    }
}

#[instrument(skip_all)]
async fn run_listener(ctx: Context) -> Result<()> {
    let mut shutdown = ctx.shutdown.subscribe();

    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => {
                info!("listener received shutdown signal");
                return Ok(());
            },
            result = server::run(ctx.clone()) => match result {
                Ok(()) => return Ok(()),
                Err(err) => {
                    error!("restarting listener: {err:#}");
                    sleep(Duration::from_secs(1)).await;
                }
            },
        }
    }
}

#[instrument(skip_all)]
async fn run_reporter(ctx: Context) -> Result<()> {
    let mut shutdown = ctx.shutdown.subscribe();
    let mut ticker = interval(REPORT_INTERVAL);
    ticker.tick().await;
    let mut last_ingested = 0u64;
    let mut last_sent = 0u64;
    let mut last_dropped = 0u64;

    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => {
                info!("reporter received shutdown signal");
                return Ok(());
            }
            _ = ticker.tick() => {
                let report = ctx.cache.report();
                let expected = ctx.feeds.assets.len();
                let stale = report.stale + expected.saturating_sub(report.feeds);
                let ingested = report.ingested.saturating_sub(last_ingested);
                let sent = report.sent.saturating_sub(last_sent);
                let dropped = report.dropped.saturating_sub(last_dropped);
                last_ingested = report.ingested;
                last_sent = report.sent;
                last_dropped = report.dropped;
                info!(
                    ingested,
                    ingested_total = report.ingested,
                    sent,
                    sent_total = report.sent,
                    dropped,
                    dropped_total = report.dropped,
                    consumer = if report.consumer_connected { "connected" } else { "none" },
                    sockets = ctx.sockets.load(Ordering::Relaxed),
                    feeds = report.feeds,
                    expected,
                    stale,
                    oldest_feed_ms = report.oldest_feed_ms,
                    "ingest report"
                );
            }
        }
    }
}
