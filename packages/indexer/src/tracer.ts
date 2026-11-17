// ABOUTME: Starts dd-trace for Node runtime metrics (event loop delay, GC, heap, CPU) only.
// ABOUTME: Keeps APM tracing and profiling off unless explicitly opted in through the environment.
import tracer from "dd-trace"

export type TracerInit = (_options: {
  profiling: boolean
  runtimeMetrics: boolean
  url: string
}) => unknown

/**
 * Starts dd-trace for Node runtime metrics only (event loop delay, GC, heap, CPU).
 * dd-trace has no programmatic switch for APM tracing, so DD_TRACE_ENABLED is forced to
 * "false" in `env` unless it is exactly "true"; profiling stays off.
 * Call it once the service is ready so the boot stall is not recorded as event-loop delay.
 * @param options - `env` defaults to process.env; `init` defaults to dd-trace's tracer.init and is injectable for tests.
 * @returns true when the tracer was initialised, false when DATADOG_AGENT_URL is unset (local runs).
 */
export const initRuntimeMetrics = (
  options: { env?: NodeJS.ProcessEnv; init?: TracerInit } = {}
): boolean => {
  const env = options.env ?? process.env
  if (!env.DATADOG_AGENT_URL) {
    return false
  }
  if (env.DD_TRACE_ENABLED !== "true") {
    env.DD_TRACE_ENABLED = "false"
  }
  const init: TracerInit =
    options.init ?? ((tracerOptions) => tracer.init(tracerOptions))
  init({
    profiling: false,
    runtimeMetrics: true,
    url: env.DATADOG_AGENT_URL,
  })
  return true
}
