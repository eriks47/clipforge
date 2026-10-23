import { NavLink, Outlet } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  Folder01Icon,
  Moon02Icon,
  Rocket01Icon,
  Settings02Icon,
  Sun03Icon,
  VideoReplayIcon,
  PlayListIcon,
} from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { useServerEvents } from "@/lib/events"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { LlmSwitcher } from "@/components/llm-switcher"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

const NAV = [
  { to: "/", label: "Projects", icon: Folder01Icon, end: true },
  { to: "/renders", label: "Renders", icon: Rocket01Icon },
  { to: "/artifacts", label: "Artifacts", icon: PlayListIcon },
  { to: "/settings", label: "Settings", icon: Settings02Icon },
]

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          <HugeiconsIcon
            icon={isDark ? Sun03Icon : Moon02Icon}
            strokeWidth={2}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Toggle theme</TooltipContent>
    </Tooltip>
  )
}

export function AppShell() {
  const connected = useServerEvents()
  const system = useQuery({
    queryKey: ["system"],
    queryFn: api.system,
    staleTime: 60_000,
  })

  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-6 border-b px-4">
        <NavLink
          to="/"
          className="flex items-center gap-2 font-heading text-sm font-semibold tracking-tight"
        >
          <span className="flex size-6 items-center justify-center bg-primary text-primary-foreground">
            <HugeiconsIcon
              icon={VideoReplayIcon}
              strokeWidth={2}
              className="size-4"
            />
          </span>
          ClipForge
        </NavLink>
        <nav className="flex items-center gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  "flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                  isActive && "bg-muted text-foreground"
                )
              }
            >
              <HugeiconsIcon icon={n.icon} strokeWidth={2} className="size-4" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LlmSwitcher />
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "size-2",
                  connected ? "bg-primary" : "bg-destructive"
                )}
                aria-label={connected ? "Connected" : "Disconnected"}
              />
            </TooltipTrigger>
            <TooltipContent>
              {connected ? "Live updates connected" : "Server not reachable"}
            </TooltipContent>
          </Tooltip>
          <ThemeToggle />
        </div>
      </header>
      {system.data && (!system.data.ffmpeg.ok || !system.data.python.ok) ? (
        <div className="border-b px-4 py-2">
          <Alert variant="destructive">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
            <AlertTitle>Setup incomplete</AlertTitle>
            <AlertDescription>
              {!system.data.ffmpeg.ok
                ? "ffmpeg/ffprobe not found on PATH. "
                : ""}
              {!system.data.python.ok
                ? `${system.data.python.detail ?? "Python workers missing."}`
                : ""}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
