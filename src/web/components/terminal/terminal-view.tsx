import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Command, Eraser, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui/resizable";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { TerminalPane, type TerminalConnectionState, type TerminalPaneHandle } from "./terminal-pane";
import type { TerminalStatusState } from "../../../shared/protocol";

const SESSION_STORAGE_KEY = "command-center.session-id";
const STACK_LAYOUT_BREAKPOINT_PX = 1100;

function getOrCreateSessionId() {
  const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const created = crypto.randomUUID();
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, created);
  return created;
}

async function fetchHealth() {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error(`health request failed with ${response.status}`);
  }
  return response.json() as Promise<{ ok: boolean; now: string }>;
}

async function fetchSession(sessionId: string) {
  const response = await fetch(`/api/session/${sessionId}`);
  if (!response.ok) {
    throw new Error(`session request failed with ${response.status}`);
  }

  return response.json() as Promise<{
    id: string;
    state: TerminalStatusState;
    connected: boolean;
    cols: number;
    rows: number;
    pid: number | null;
    createdAt: string;
    lastActiveAt: string;
  }>;
}

function badgeVariantForConnection(state: TerminalConnectionState) {
  if (state === "connected") {
    return "success" as const;
  }

  if (state === "connecting") {
    return "warning" as const;
  }

  return "outline" as const;
}

export function TerminalView() {
  const sessionId = useMemo(() => getOrCreateSessionId(), []);
  const terminalRef = useRef<TerminalPaneHandle | null>(null);

  const [connectionState, setConnectionState] = useState<TerminalConnectionState>("connecting");
  const [terminalState, setTerminalState] = useState<TerminalStatusState>("starting");
  const [isStackedLayout, setIsStackedLayout] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.matchMedia(`(max-width: ${STACK_LAYOUT_BREAKPOINT_PX}px)`).matches;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia(`(max-width: ${STACK_LAYOUT_BREAKPOINT_PX}px)`);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsStackedLayout(event.matches);
    };

    setIsStackedLayout(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 5_000,
  });

  const sessionQuery = useQuery({
    queryKey: ["session", sessionId, connectionState],
    queryFn: () => fetchSession(sessionId),
    enabled: connectionState !== "disconnected",
    refetchInterval: 2_500,
  });

  return (
    <TooltipProvider delayDuration={150}>
      <main className="mx-auto flex h-[100dvh] min-h-screen w-full max-w-[1500px] flex-col gap-3 px-3 py-3 md:gap-4 md:px-6 md:py-4">
        <header className="rounded-xl border border-border bg-card/70 px-4 py-2.5 shadow-sm backdrop-blur-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="font-heading text-xl tracking-tight">Command Center</h1>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={badgeVariantForConnection(connectionState)} className="font-mono uppercase tracking-wide">
                {connectionState}
              </Badge>
              <Badge variant="secondary" className="font-mono uppercase tracking-wide">
                {terminalState}
              </Badge>
              <Badge variant={healthQuery.data?.ok ? "success" : "outline"} className="font-mono uppercase tracking-wide">
                API {healthQuery.data?.ok ? "healthy" : "pending"}
              </Badge>
            </div>
          </div>
        </header>

        <ResizablePanelGroup
          key={isStackedLayout ? "stacked" : "split"}
          direction={isStackedLayout ? "vertical" : "horizontal"}
          className="min-h-0 flex-1 rounded-xl border border-border bg-card/40"
        >
          <ResizablePanel defaultSize={isStackedLayout ? 36 : 25} minSize={isStackedLayout ? 25 : 18} className="min-h-0">
            <Card className="flex h-full min-h-0 flex-col rounded-none border-0 bg-transparent shadow-none">
              <CardHeader className="shrink-0">
                <CardTitle>Session</CardTitle>
                <CardDescription className="font-mono text-xs">{sessionId}</CardDescription>
              </CardHeader>

              <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                <div className="grid gap-2 font-mono text-xs text-muted-foreground">
                  <div className="flex justify-between">
                    <span>pid</span>
                    <span>{sessionQuery.data?.pid ?? "--"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>size</span>
                    <span>
                      {sessionQuery.data?.cols ?? "--"} x {sessionQuery.data?.rows ?? "--"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>last active</span>
                    <span>{sessionQuery.data ? new Date(sessionQuery.data.lastActiveAt).toLocaleTimeString() : "--"}</span>
                  </div>
                </div>

                <Separator />

                <div className="flex flex-wrap gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          terminalRef.current?.reconnect();
                          toast.info("Reconnecting socket...");
                        }}
                      >
                        <RefreshCw className="h-4 w-4" />
                        Reconnect
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Reconnect WebSocket to existing shell</TooltipContent>
                  </Tooltip>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      terminalRef.current?.clear();
                      toast.message("Terminal buffer cleared");
                    }}
                  >
                    <Eraser className="h-4 w-4" />
                    Clear
                  </Button>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" className="w-full justify-between">
                      <span className="inline-flex items-center gap-2">
                        <Command className="h-4 w-4" />
                        Session Actions
                      </span>
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel>Shell</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => {
                        terminalRef.current?.reset();
                        toast.warning("Shell reset requested");
                      }}
                    >
                      Reset zsh process
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        terminalRef.current?.reconnect();
                        toast.info("Reconnect requested");
                      }}
                    >
                      Reconnect socket
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardContent>
            </Card>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={isStackedLayout ? 64 : 75} minSize={isStackedLayout ? 40 : 35}>
            <Card className="h-full rounded-none border-0 bg-transparent shadow-none">
              <CardContent className="h-full rounded-md bg-[#1f1811] p-3">
                <TerminalPane
                  ref={terminalRef}
                  sessionId={sessionId}
                  onConnectionStateChange={setConnectionState}
                  onTerminalStateChange={setTerminalState}
                />
              </CardContent>
            </Card>
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>
    </TooltipProvider>
  );
}
