use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{
    LogExporter, MetricExporter, Protocol, SpanExporter, WithExportConfig as _, WithHttpConfig as _,
};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing::level_filters::LevelFilter;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;
use tracing_subscriber::{EnvFilter, Layer as _, fmt};

use crate::config::TelemetryConfig;

pub const TRACE_TARGET: &str = "ingest";

const EXPORT_ERROR_INTERVAL: Duration = Duration::from_secs(60);
const METRIC_EXPORT_INTERVAL: Duration = Duration::from_secs(15);

pub struct Providers {
    tracer: SdkTracerProvider,
    meter: SdkMeterProvider,
    logger: SdkLoggerProvider,
}

impl Providers {
    pub fn shutdown(&self) {
        if let Err(err) = self.tracer.shutdown() {
            eprintln!("failed to shut down trace exporter: {err}");
        }
        if let Err(err) = self.meter.shutdown() {
            eprintln!("failed to shut down metric exporter: {err}");
        }
        if let Err(err) = self.logger.shutdown() {
            eprintln!("failed to shut down log exporter: {err}");
        }
    }
}

pub fn init(config: Option<&TelemetryConfig>) -> Result<Option<Providers>> {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"))
        .add_directive("yawc=warn".parse()?)
        .add_directive("opentelemetry=off".parse()?)
        .add_directive("opentelemetry_sdk=off".parse()?);

    let fmt_layer = fmt::layer()
        .with_target(false)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .with_level(true)
        .with_ansi(true)
        .without_time()
        .with_filter(env_filter);

    let registry = tracing_subscriber::registry().with(fmt_layer);

    match config {
        None => {
            registry
                .try_init()
                .context("failed to install tracing subscriber")?;
            Ok(None)
        }
        Some(config) => {
            let providers = build_providers(config)?;
            let otel_layer = tracing_opentelemetry::layer()
                .with_tracer(providers.tracer.tracer(config.service_name.clone()))
                .with_filter(Targets::new().with_target(TRACE_TARGET, LevelFilter::TRACE));

            let log_layer = OpenTelemetryTracingBridge::new(&providers.logger).with_filter(
                Targets::new()
                    .with_default(LevelFilter::INFO)
                    .with_target("opentelemetry", LevelFilter::OFF)
                    .with_target("opentelemetry_sdk", LevelFilter::OFF)
                    .with_target("hyper", LevelFilter::OFF)
                    .with_target("reqwest", LevelFilter::OFF)
                    .with_target("h2", LevelFilter::OFF),
            );
            registry
                .with(otel_layer)
                .with(log_layer)
                .with(ExportErrorThrottle::new(config.endpoint.clone()))
                .try_init()
                .context("failed to install tracing subscriber")?;
            tracing::info!(
                endpoint = %config.endpoint,
                service_name = %config.service_name,
                instance_id = %config.instance_id,
                auth = config.auth_token.is_some(),
                "OTLP telemetry export enabled"
            );
            Ok(Some(providers))
        }
    }
}

pub async fn probe(config: &TelemetryConfig) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            tracing::warn!("failed to build OTLP probe client: {err:#}");
            return;
        }
    };

    let mut request = client
        .post(config.traces_url())
        .header("content-type", "application/x-protobuf")
        .body(Vec::new());
    if let Some(token) = &config.auth_token {
        request = request.bearer_auth(token);
    }

    match request.send().await {
        Ok(response) if response.status().is_success() => {
            tracing::info!(endpoint = %config.endpoint, "OTLP endpoint is reachable");
        }
        Ok(response) => {
            tracing::warn!(
                endpoint = %config.endpoint,
                status = %response.status(),
                "OTLP endpoint rejected the probe, trace exports will likely fail"
            );
        }
        Err(err) => {
            tracing::warn!(
                endpoint = %config.endpoint,
                "OTLP endpoint is unreachable, trace exports will fail until it recovers: {err:#}"
            );
        }
    }
}

struct ExportErrorThrottle {
    endpoint: String,
    dropped: AtomicU64,
    next_log_unix_ms: AtomicU64,
}

impl ExportErrorThrottle {
    fn new(endpoint: String) -> Self {
        Self {
            endpoint,
            dropped: AtomicU64::new(0),
            next_log_unix_ms: AtomicU64::new(0),
        }
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for ExportErrorThrottle {
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let metadata = event.metadata();
        if *metadata.level() != tracing::Level::ERROR
            || !metadata.target().starts_with("opentelemetry")
        {
            return;
        }
        self.dropped.fetch_add(1, Ordering::Relaxed);

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let next_log = self.next_log_unix_ms.load(Ordering::Relaxed);
        let claimed = now_ms >= next_log
            && self
                .next_log_unix_ms
                .compare_exchange(
                    next_log,
                    now_ms + EXPORT_ERROR_INTERVAL.as_millis() as u64,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                )
                .is_ok();
        if claimed {
            let dropped = self.dropped.swap(0, Ordering::Relaxed);
            tracing::error!(
                dropped_batches = dropped,
                endpoint = %self.endpoint,
                "failed to export OTEL traces, dropping batches while retrying"
            );
        }
    }
}

fn build_providers(config: &TelemetryConfig) -> Result<Providers> {
    let mut headers = HashMap::new();
    if let Some(token) = &config.auth_token {
        headers.insert("Authorization".to_string(), format!("Bearer {token}"));
    }

    let resource = Resource::builder()
        .with_service_name(config.service_name.clone())
        .with_attribute(KeyValue::new("service.version", env!("CARGO_PKG_VERSION")))
        .with_attribute(KeyValue::new(
            "service.instance.id",
            config.instance_id.clone(),
        ))
        .with_attribute(KeyValue::new("host.name", config.instance_id.clone()))
        .build();

    let span_exporter = SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(config.traces_url())
        .with_headers(headers.clone())
        .build()
        .context("failed to build OTLP span exporter")?;
    let tracer = SdkTracerProvider::builder()
        .with_batch_exporter(span_exporter)
        .with_resource(resource.clone())
        .build();
    opentelemetry::global::set_tracer_provider(tracer.clone());

    let metric_exporter = MetricExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(config.metrics_url())
        .with_headers(headers.clone())
        .build()
        .context("failed to build OTLP metric exporter")?;
    let meter = SdkMeterProvider::builder()
        .with_reader(
            PeriodicReader::builder(metric_exporter)
                .with_interval(METRIC_EXPORT_INTERVAL)
                .build(),
        )
        .with_resource(resource.clone())
        .build();
    opentelemetry::global::set_meter_provider(meter.clone());

    let log_exporter = LogExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(config.logs_url())
        .with_headers(headers)
        .build()
        .context("failed to build OTLP log exporter")?;
    let logger = SdkLoggerProvider::builder()
        .with_batch_exporter(log_exporter)
        .with_resource(resource)
        .build();

    Ok(Providers {
        tracer,
        meter,
        logger,
    })
}
