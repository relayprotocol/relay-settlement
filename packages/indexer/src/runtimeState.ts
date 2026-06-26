export type RuntimeRoles = {
  enableApi: boolean
  doBackgroundWork: boolean
}

export type RuntimeReadinessSnapshot = RuntimeRoles & {
  apiReady: boolean
  backgroundWorkReady: boolean
  backgroundWorkError: string | null
}

export type RuntimeLivenessResponse = {
  ok: true
  roles: RuntimeRoles
}

export type RuntimeReadinessResponse = {
  ok: boolean
  roles: RuntimeRoles
  api: {
    ready: boolean
    required: boolean
  }
  backgroundWork: {
    error: string | null
    ready: boolean
    required: boolean
  }
}

export const buildLivenessResponse = (
  roles: RuntimeRoles
): RuntimeLivenessResponse => ({
  ok: true,
  roles,
})

export const buildReadinessResponse = ({
  enableApi,
  doBackgroundWork,
  apiReady,
  backgroundWorkReady,
  backgroundWorkError,
}: RuntimeReadinessSnapshot): RuntimeReadinessResponse => {
  const apiRequired = enableApi
  const backgroundWorkRequired = doBackgroundWork
  const ok =
    (!apiRequired || apiReady) &&
    (!backgroundWorkRequired || backgroundWorkReady)

  return {
    api: {
      ready: apiRequired ? apiReady : false,
      required: apiRequired,
    },
    backgroundWork: {
      error: backgroundWorkRequired ? backgroundWorkError : null,
      ready: backgroundWorkRequired ? backgroundWorkReady : false,
      required: backgroundWorkRequired,
    },
    ok,
    roles: {
      doBackgroundWork,
      enableApi,
    },
  }
}

export type RuntimeState = ReturnType<typeof createRuntimeState>

export const createRuntimeState = (roles: RuntimeRoles) => {
  let apiReady = false
  let backgroundWorkReady = false
  let backgroundWorkError: string | null = null

  return {
    doBackgroundWork: roles.doBackgroundWork,
    enableApi: roles.enableApi,
    getLiveness() {
      return buildLivenessResponse(roles)
    },
    getReadiness() {
      return buildReadinessResponse({
        ...roles,
        apiReady,
        backgroundWorkError,
        backgroundWorkReady,
      })
    },
    markApiReady() {
      apiReady = true
    },
    markBackgroundWorkReady() {
      backgroundWorkReady = true
      backgroundWorkError = null
    },
    markBackgroundWorkUnready(error: string | Error) {
      backgroundWorkReady = false
      backgroundWorkError =
        error instanceof Error ? error.message : String(error)
    },
    roles,
  }
}
