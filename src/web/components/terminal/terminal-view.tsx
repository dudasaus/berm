import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Command, Eraser, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
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
import {
  TerminalPane,
  type SessionUnavailableReason,
  type TerminalConnectionState,
  type TerminalPaneHandle,
} from "./terminal-pane";
import type { TerminalStatusState } from "../../../shared/protocol";

const STACK_LAYOUT_BREAKPOINT_PX = 1100;
const SELECTED_SESSION_STORAGE_KEY = "command-center.selected-session-id";

type SessionMetadata = {
  id: string;
  state: TerminalStatusState;
  connected: boolean;
  cols: number;
  rows: number;
  pid: number | null;
  createdAt: string;
  lastActiveAt: string;
  attachedClients: number;
};

async function fetchHealth() {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error(`health request failed with ${response.status}`);
  }
  return response.json() as Promise<{ ok: boolean; now: string }>;
}

async function fetchSessions() {
  const response = await fetch("/api/sessions");
  if (!response.ok) {
    throw new Error(`sessions request failed with ${response.status}`);
  }

  const payload = (await response.json()) as { sessions?: SessionMetadata[] } | SessionMetadata[];
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.sessions ?? [];
}

async function createSession(request: { name?: string }) {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });

  const payload = (await response.json()) as SessionMetadata | { error?: string };
  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : `create session failed with ${response.status}`);
  }

  return payload as SessionMetadata;
}

async function deleteSession(sessionId: string) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `delete session failed with ${response.status}`);
  }

  return true;
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

function readStoredSessionId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.sessionStorage.getItem(SELECTED_SESSION_STORAGE_KEY);
}

function promptForOptionalSessionName(): string | undefined | null {
  const provided = window.prompt(
    "Enter a session name (letters, numbers, underscores, hyphens). Leave blank for auto-generated.",
  );

  if (provided === null) {
    return null;
  }

  const trimmed = provided.trim();
  return trimmed || undefined;
}

export function TerminalView() {
  const terminalRef = useRef<TerminalPaneHandle | null>(null);
  const queryClient = useQueryClient();

  const [connectionState, setConnectionState] = useState<TerminalConnectionState>("disconnected");
  const [terminalState, setTerminalState] = useState<TerminalStatusState>("starting");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => readStoredSessionId());
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

  useEffect(() => {
    if (selectedSessionId) {
      window.sessionStorage.setItem(SELECTED_SESSION_STORAGE_KEY, selectedSessionId);
    } else {
      window.sessionStorage.removeItem(SELECTED_SESSION_STORAGE_KEY);
    }
  }, [selectedSessionId]);

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 5_000,
  });

  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: 2_500,
  });

  const createSessionMutation = useMutation({
    mutationFn: createSession,
    onSuccess: (createdSession) => {
      setSelectedSessionId(createdSession.id);
      toast.success(`Created session ${createdSession.id}`);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: (deleted, sessionId) => {
      if (!deleted) {
        toast.info(`Session ${sessionId} no longer exists`);
      } else {
        toast.success(`Deleted session ${sessionId}`);
      }

      if (selectedSessionId === sessionId) {
        setSelectedSessionId(null);
      }

      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const sessions = sessionsQuery.data ?? [];
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );

  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedSessionId !== null) {
        setSelectedSessionId(null);
      }
      return;
    }

    if (selectedSessionId && sessions.some((session) => session.id === selectedSessionId)) {
      return;
    }

    const stored = readStoredSessionId();
    if (stored && sessions.some((session) => session.id === stored)) {
      setSelectedSessionId(stored);
      return;
    }

    const firstSession = sessions[0];
    if (firstSession) {
      setSelectedSessionId(firstSession.id);
    }
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    if (!selectedSession) {
      setConnectionState("disconnected");
    }
  }, [selectedSession]);

  const handleCreateAutoSession = () => {
    createSessionMutation.mutate({});
  };

  const handleCreateNamedSession = () => {
    const desiredName = promptForOptionalSessionName();
    if (desiredName === null) {
      return;
    }

    createSessionMutation.mutate({ name: desiredName });
  };

  const handleDeleteSession = (sessionId: string) => {
    const confirmed = window.confirm(`Delete session '${sessionId}'? This will kill the tmux session.`);
    if (!confirmed) {
      return;
    }

    deleteSessionMutation.mutate(sessionId);
  };

  const handleSessionUnavailable = useCallback(
    (sessionId: string, reason: SessionUnavailableReason) => {
      setSelectedSessionId((current) => (current === sessionId ? null : current));
      toast.warning(reason === "deleted" ? `Session ${sessionId} was deleted` : `Session ${sessionId} was not found`);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    [queryClient],
  );

  const connectionBadgeText = selectedSession ? connectionState : "no-session";

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
                {connectionBadgeText}
              </Badge>
              <Badge variant="secondary" className="font-mono uppercase tracking-wide">
                {terminalState}
              </Badge>
              <Badge variant={healthQuery.data?.ok ? "success" : "outline"} className="font-mono uppercase tracking-wide">
                API {healthQuery.data?.ok ? "healthy" : "pending"}
              </Badge>
              <Badge variant="outline" className="font-mono uppercase tracking-wide">
                sessions {sessions.length}
              </Badge>
            </div>
          </div>
        </header>

        <ResizablePanelGroup
          key={isStackedLayout ? "stacked" : "split"}
          direction={isStackedLayout ? "vertical" : "horizontal"}
          className="min-h-0 flex-1 rounded-xl border border-border bg-card/40"
        >
          <ResizablePanel defaultSize={isStackedLayout ? 36 : 28} minSize={isStackedLayout ? 25 : 20} className="min-h-0">
            <Card className="flex h-full min-h-0 flex-col rounded-none border-0 bg-transparent shadow-none">
              <CardHeader className="shrink-0 pb-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <CardTitle>Sessions</CardTitle>
                    <CardDescription className="font-mono text-xs">
                      {selectedSession ? `selected: ${selectedSession.id}` : "No session selected"}
                    </CardDescription>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="secondary" disabled={createSessionMutation.isPending}>
                        <Plus className="h-4 w-4" />
                        New
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuLabel>Create Session</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={handleCreateAutoSession}>Auto name</DropdownMenuItem>
                      <DropdownMenuItem onSelect={handleCreateNamedSession}>Custom name</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>

              <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                {sessions.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                    <p>No tmux sessions yet.</p>
                    <Button size="sm" variant="outline" className="mt-2" onClick={handleCreateAutoSession}>
                      <Plus className="h-4 w-4" />
                      Create first session
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {sessions.map((session) => {
                      const isSelected = session.id === selectedSessionId;

                      return (
                        <div
                          key={session.id}
                          className={`rounded-md border p-2 ${isSelected ? "border-primary/60 bg-primary/10" : "border-border bg-card/60"}`}
                        >
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() => {
                                setSelectedSessionId(session.id);
                              }}
                            >
                              <p className="truncate font-mono text-sm font-semibold">{session.id}</p>
                              <p className="font-mono text-[11px] text-muted-foreground">
                                active {new Date(session.lastActiveAt).toLocaleTimeString()} · clients {session.attachedClients}
                              </p>
                            </button>

                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  onClick={() => {
                                    handleDeleteSession(session.id);
                                  }}
                                  disabled={deleteSessionMutation.isPending}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Delete session</TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {selectedSession ? (
                  <>
                    <Separator />

                    <div className="grid gap-2 font-mono text-xs text-muted-foreground">
                      <div className="flex justify-between">
                        <span>pid</span>
                        <span>{selectedSession.pid ?? "--"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>size</span>
                        <span>
                          {selectedSession.cols} x {selectedSession.rows}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>attached clients</span>
                        <span>{selectedSession.attachedClients}</span>
                      </div>
                    </div>

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
                            disabled={!selectedSession}
                          >
                            <RefreshCw className="h-4 w-4" />
                            Reconnect
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Reconnect WebSocket to selected session</TooltipContent>
                      </Tooltip>

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          terminalRef.current?.clear();
                          toast.message("Terminal buffer cleared");
                        }}
                        disabled={!selectedSession}
                      >
                        <Eraser className="h-4 w-4" />
                        Clear
                      </Button>
                    </div>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="ghost" className="w-full justify-between" disabled={!selectedSession}>
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
                            toast.warning("Session reset requested");
                          }}
                        >
                          Reset selected session
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            if (selectedSession) {
                              handleDeleteSession(selectedSession.id);
                            }
                          }}
                        >
                          Delete selected session
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                ) : null}
              </CardContent>
            </Card>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={isStackedLayout ? 64 : 72} minSize={isStackedLayout ? 40 : 35}>
            <Card className="h-full rounded-none border-0 bg-transparent shadow-none">
              <CardContent className="h-full rounded-md bg-[#1f1811] p-3">
                {selectedSession ? (
                  <TerminalPane
                    key={selectedSession.id}
                    ref={terminalRef}
                    sessionId={selectedSession.id}
                    onConnectionStateChange={setConnectionState}
                    onTerminalStateChange={setTerminalState}
                    onSessionUnavailable={handleSessionUnavailable}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center rounded-md border border-border/30 bg-[#1f1811] text-center text-sm text-muted-foreground">
                    <div className="space-y-2">
                      <p>No session selected.</p>
                      <Button size="sm" variant="secondary" onClick={handleCreateAutoSession}>
                        <Plus className="h-4 w-4" />
                        Create session
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>
    </TooltipProvider>
  );
}
