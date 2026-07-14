mod authentication;
mod cache;
mod config;
mod ingester;
mod server;
mod telemetry;
mod verification;

use std::sync::Arc;

use anyhow::{Result, anyhow};
use rustls::crypto::ring;
use tokio::signal::ctrl_c;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::broadcast;
use tokio::time::{Duration, interval, sleep};
use tracing::{error, info, info_span, instrument, warn};

use crate::cache::FeedCache;
use crate::config::Config;

const REPORT_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct Context {
    pub shutdown: broadcast::Sender<()>,
    pub config: Arc<Config>,
    pub cache: Arc<FeedCache>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();

    let config = Arc::new(config::get()?);
    let _tracer_provider = telemetry::init(config.telemetry.as_ref())?;

    let startup = info_span!(target: telemetry::TRACE_TARGET, "startup").entered();

    ring::default_provider()
        .install_default()
        .map_err(|_| anyhow!("failed to install rustls ring crypto provider"))?;

    let (shutdown, _) = broadcast::channel::<()>(1);
    let ctx = Context {
        shutdown: shutdown.clone(),
        config,
        cache: Arc::new(FeedCache::new()),
    };

    drop(startup);

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

    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => {
                info!("reporter received shutdown signal");
                return Ok(());
            }
            _ = ticker.tick() => {
                let report = ctx.cache.report();
                let ingested = report.ingested.saturating_sub(last_ingested);
                let sent = report.sent.saturating_sub(last_sent);
                last_ingested = report.ingested;
                last_sent = report.sent;
                info!(
                    ingested,
                    ingested_total = report.ingested,
                    sent,
                    sent_total = report.sent,
                    regressed_total = report.regressed,
                    consumer = if report.consumer_connected { "connected" } else { "none" },
                    feeds = report.feeds,
                    expected = ctx.config.feed_ids.len(),
                    oldest_sec = report.oldest_sec,
                    "ingest report"
                );
            }
        }
    }
}
