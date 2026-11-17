import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router/dom"
import { QueryClientProvider } from "@tanstack/react-query"
import "@fontsource-variable/inter"
import "@fontsource/roboto-mono/400.css"
import { TooltipProvider } from "./components/Tooltip"
import { queryClient } from "./queryClient"
import { router } from "./router"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>
)
