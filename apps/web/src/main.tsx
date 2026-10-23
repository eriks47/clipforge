import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createBrowserRouter, RouterProvider } from "react-router"

import "./index.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppShell } from "@/components/app-shell"
import { ProjectsPage } from "@/pages/projects"
import { ReviewPage } from "@/pages/review"
import { EditorPage } from "@/pages/editor"
import { RendersPage } from "@/pages/renders"
import { ArtifactsPage } from "@/pages/artifacts"
import { SettingsPage } from "@/pages/settings"
import { ApiError } from "@/lib/api"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      // The API may still be starting or restarting (dev reloads): keep retrying network and
      // server errors with backoff; a 4xx is a real answer and is not retried.
      retry: (failures, error) =>
        !(
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        ) && failures < 8,
      retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
    },
  },
})

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <ProjectsPage /> },
      { path: "/projects/:id", element: <ReviewPage /> },
      { path: "/clips/:id", element: <EditorPage /> },
      { path: "/renders", element: <RendersPage /> },
      { path: "/artifacts", element: <ArtifactsPage /> },
      { path: "/settings", element: <SettingsPage /> },
    ],
  },
])

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
)
