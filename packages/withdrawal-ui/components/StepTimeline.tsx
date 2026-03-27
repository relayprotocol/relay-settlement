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
    <div className="card py-3 px-4">
      {/* Horizontal steps with labels */}
      <div className="flex items-start">
        {steps.map((step, index) => {
          const isComplete =
            index < currentStepIndex ||
            (index === steps.length - 1 && index === currentStepIndex)
          const isCurrent = index === currentStepIndex && !isComplete
          const isLast = index === steps.length - 1

          return (
            <div
              key={step.key}
              className="flex items-start flex-1 last:flex-none"
            >
              {/* Step column */}
              <div
                className="flex flex-col items-center"
                style={{ minWidth: 48 }}
              >
                {/* Dot */}
                {isComplete ? (
                  <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">
                    <svg
                      className="w-3.5 h-3.5 text-green-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2.5}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                ) : isCurrent ? (
                  <div className="w-6 h-6 rounded-full bg-primary-100 flex items-center justify-center">
                    <div className="w-2.5 h-2.5 rounded-full bg-primary-500 animate-pulse" />
                  </div>
                ) : (
                  <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center">
                    <div className="w-2 h-2 rounded-full bg-gray-300" />
                  </div>
                )}

                {/* Label */}
                <span
                  className={`text-[11px] mt-1.5 text-center leading-tight ${
                    isCurrent
                      ? "text-default font-medium"
                      : isComplete
                        ? "text-green-700"
                        : "text-gray-400"
                  }`}
                >
                  {step.label}
                </span>
              </div>

              {/* Connector line */}
              {!isLast && (
                <div
                  className={`flex-1 h-0.5 mt-3 mx-1 rounded ${
                    isComplete ? "bg-green-300" : "bg-gray-200"
                  }`}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
