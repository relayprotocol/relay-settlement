"use client"

export interface StepInfo {
  key: string
  label: string
  description: string
}

interface StepTimelineProps {
  steps: StepInfo[]
  currentStepIndex: number
}

export function StepTimeline({ steps, currentStepIndex }: StepTimelineProps) {
  return (
    <div className="card">
      <div className="space-y-0">
        {steps.map((step, index) => {
          const isComplete =
            index < currentStepIndex ||
            (index === steps.length - 1 && index === currentStepIndex)
          const isCurrent = index === currentStepIndex && !isComplete
          const isLast = index === steps.length - 1

          return (
            <div key={step.key} className="relative">
              {/* Connector line */}
              {!isLast && (
                <div
                  className={`absolute left-4 top-8 w-0.5 h-full -ml-px ${
                    isComplete ? "bg-green-300" : "bg-gray-200"
                  }`}
                />
              )}

              <div
                className={`relative flex gap-4 pb-6 ${isLast ? "pb-0" : ""}`}
              >
                {/* Icon */}
                <div className="flex-shrink-0">
                  <StepIcon isComplete={isComplete} isCurrent={isCurrent} />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3
                      className={`font-medium ${
                        isCurrent
                          ? "text-default"
                          : isComplete
                            ? "text-green-700"
                            : "text-gray-400"
                      }`}
                    >
                      {step.label}
                    </h3>
                    {isCurrent && (
                      <span className="text-xs text-primary-600 bg-primary-50 px-2 py-0.5 rounded-full">
                        Current
                      </span>
                    )}
                  </div>
                  {(isCurrent || isComplete) && (
                    <p className="text-sm text-subtle mt-0.5">
                      {step.description}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StepIcon({
  isComplete,
  isCurrent,
}: {
  isComplete: boolean
  isCurrent: boolean
}) {
  if (isComplete) {
    return (
      <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
        <svg
          className="w-4 h-4 text-green-600"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 13l4 4L19 7"
          />
        </svg>
      </div>
    )
  }

  if (isCurrent) {
    return (
      <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center">
        <div className="spinner !w-4 !h-4" />
      </div>
    )
  }

  return (
    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
      <div className="w-2.5 h-2.5 rounded-full bg-gray-300" />
    </div>
  )
}
