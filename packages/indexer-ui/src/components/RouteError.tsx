import { isRouteErrorResponse, useRouteError } from "react-router"
import { TriangleAlert } from "lucide-react"
import { Button } from "./ui"

const errorMessage = (error: unknown) =>
  isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error)

export default function RouteError() {
  const error = useRouteError()
  return (
    <section
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-error-line bg-error-bg px-4 py-10 text-center text-sm text-error-fg"
    >
      <TriangleAlert aria-hidden className="size-5" />
      <h2 className="font-semibold">Something Went Wrong</h2>
      <p className="max-w-prose wrap-anywhere">{errorMessage(error)}</p>
      <Button onClick={() => location.reload()}>Reload</Button>
    </section>
  )
}
