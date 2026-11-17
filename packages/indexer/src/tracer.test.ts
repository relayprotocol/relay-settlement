// ABOUTME: Tests for the Datadog runtime metrics bootstrap in tracer.ts.
// ABOUTME: Uses an injected init spy and explicit env objects so process.env is never touched.
import assert from "node:assert/strict"
import test from "node:test"
import { initRuntimeMetrics, type TracerInit } from "./tracer.js"

const agentUrl = "http://datadog-agent:8126"

const createInitSpy = () => {
  const calls: Parameters<TracerInit>[0][] = []
  const init: TracerInit = (options) => {
    calls.push(options)
  }
  return { calls, init }
}

test("initRuntimeMetrics skips init when DATADOG_AGENT_URL is unset", () => {
  const { calls, init } = createInitSpy()
  const env: NodeJS.ProcessEnv = {}

  const started = initRuntimeMetrics({ env, init })

  assert.equal(started, false)
  assert.equal(calls.length, 0)
  assert.equal(env.DD_TRACE_ENABLED, undefined)
})

test("initRuntimeMetrics enables runtime metrics and forces tracing off by default", () => {
  const { calls, init } = createInitSpy()
  const env: NodeJS.ProcessEnv = { DATADOG_AGENT_URL: agentUrl }

  const started = initRuntimeMetrics({ env, init })

  assert.equal(started, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    profiling: false,
    runtimeMetrics: true,
    url: agentUrl,
  })
  assert.equal(env.DD_TRACE_ENABLED, "false")
})

test("initRuntimeMetrics keeps tracing on when DD_TRACE_ENABLED is true", () => {
  const { calls, init } = createInitSpy()
  const env: NodeJS.ProcessEnv = {
    DATADOG_AGENT_URL: agentUrl,
    DD_TRACE_ENABLED: "true",
  }

  initRuntimeMetrics({ env, init })

  assert.equal(calls.length, 1)
  assert.equal(env.DD_TRACE_ENABLED, "true")
})

for (const value of ["1", "false"]) {
  test(`initRuntimeMetrics forces tracing off when DD_TRACE_ENABLED is ${value}`, () => {
    const { calls, init } = createInitSpy()
    const env: NodeJS.ProcessEnv = {
      DATADOG_AGENT_URL: agentUrl,
      DD_TRACE_ENABLED: value,
    }

    initRuntimeMetrics({ env, init })

    assert.equal(calls.length, 1)
    assert.equal(env.DD_TRACE_ENABLED, "false")
  })
}
