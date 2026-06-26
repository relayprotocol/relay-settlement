use anyhow::{Context as _, Result};
use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig as _};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::{Sampler, SdkTracerProvider};
use tracing::level_filters::LevelFilter;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;
use tracing_subscriber::{EnvFilter, Layer as _, fmt};

use crate::config::TelemetryConfig;

pub const TRACE_TARGET: &str = "ingest";

pub fn init(config: Option<&TelemetryConfig>) -> Result<Option<SdkTracerProvider>> {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

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
            let provider = build_provider(config)?;
            let otel_layer = tracing_opentelemetry::layer()
                .with_tracer(provider.tracer(config.service_name.clone()))
                .with_filter(Targets::new().with_target(TRACE_TARGET, LevelFilter::TRACE));
            registry
                .with(otel_layer)
                .try_init()
                .context("failed to install tracing subscriber")?;
            Ok(Some(provider))
        }
    }
}

fn build_provider(config: &TelemetryConfig) -> Result<SdkTracerProvider> {
    let exporter = SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(config.endpoint.clone())
        .build()
        .context("failed to build OTLP span exporter")?;

    let resource = Resource::builder()
        .with_service_name(config.service_name.clone())
        .with_attribute(KeyValue::new("service.version", env!("CARGO_PKG_VERSION")))
        .build();

    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(resource)
        .with_sampler(Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(
            config.sample_ratio,
        ))))
        .build();

    opentelemetry::global::set_tracer_provider(provider.clone());
    Ok(provider)
}
