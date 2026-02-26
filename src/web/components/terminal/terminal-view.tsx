import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Command,
  Eraser,
  FolderOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
} from "lucide-react";
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
const SELECTED_PROJECT_STORAGE_KEY = "command-center.selected-project-id";

function selectedSessionStorageKey(projectId: string) {
  return `command-center.selected-session-id.${projectId}`;
}

function sessionOrderStorageKey(projectId: string) {
  return `command-center.session-order.${projectId}`;
}

type ProjectMetadata = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastUsedAt: string;
  worktreeEnabled: boolean;
  worktreeParentPath: string | null;
};

type SessionMetadata = {
  id: string;
  projectId: string;
  state: TerminalStatusState;
  connected: boolean;
  cols: number;
  rows: number;
  pid: number | null;
  createdAt: string;
  lastActiveAt: string;
  attachedClients: number;
  workspaceType: "main" | "worktree";
  workspacePath: string;
  branchName: string | null;
};

async function fetchHealth() {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error(`health request failed with ${response.status}`);
  }
  return response.json() as Promise<{ ok: boolean; now: string }>;
}

async function fetchProjects() {
  const response = await fetch("/api/projects");
  if (!response.ok) {
    throw new Error(`projects request failed with ${response.status}`);
  }

  const payload = (await response.json()) as { projects?: ProjectMetadata[] } | ProjectMetadata[];
  if (Array.isArray(payload)) {
    return payload;
  }

  return payload.projects ?? [];
}

async function selectProject(path: string) {
  const response = await fetch("/api/projects/select", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ path }),
  });

  const payload = (await response.json()) as ProjectMetadata | { error?: string };
  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : `select project failed with ${response.status}`);
  }

  return payload as ProjectMetadata;
}

async function pickProjectPath() {
  const response = await fetch("/api/projects/pick", {
    method: "POST",
  });

  const payload = (await response.json()) as { path?: string; error?: string; code?: string };
  if (!response.ok) {
    const error = payload.error ?? `project picker failed with ${response.status}`;
    const code = payload.code ?? "PROJECT_PICK_FAILED";
    throw new Error(`${code}: ${error}`);
  }

  if (!payload.path || typeof payload.path !== "string") {
    throw new Error("PROJECT_PICK_EMPTY: No project path returned by picker");
  }

  return payload.path;
}

async function fetchSessions(projectId: string) {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
  if (!response.ok) {
    throw new Error(`sessions request failed with ${response.status}`);
  }

  const payload = (await response.json()) as { sessions?: SessionMetadata[] } | SessionMetadata[];
  if (Array.isArray(payload)) {
    return payload;
  }

  return payload.sessions ?? [];
}

async function createSession(
  request:
    | { projectId: string; mode?: "main"; name?: string }
    | { projectId: string; mode: "worktree"; branchName: string },
) {
  const response = await fetch(`/api/projects/${encodeURIComponent(request.projectId)}/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(
      request.mode === "worktree"
        ? { mode: "worktree", branchName: request.branchName }
        : { mode: "main", name: request.name },
    ),
  });

  const payload = (await response.json()) as SessionMetadata | { error?: string };
  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : `create session failed with ${response.status}`);
  }

  return payload as SessionMetadata;
}

async function updateProject(request: {
  projectId: string;
  worktreeEnabled?: boolean;
  worktreeParentPath?: string | null;
}) {
  const response = await fetch(`/api/projects/${encodeURIComponent(request.projectId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      worktreeEnabled: request.worktreeEnabled,
      worktreeParentPath: request.worktreeParentPath,
    }),
  });

  const payload = (await response.json()) as ProjectMetadata | { error?: string };
  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : `update project failed with ${response.status}`);
  }

  return payload as ProjectMetadata;
}

async function deleteSession(request: { projectId: string; sessionId: string }) {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(request.projectId)}/sessions/${encodeURIComponent(request.sessionId)}`,
    {
      method: "DELETE",
    },
  );

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `delete session failed with ${response.status}`);
  }

  return true;
}

async function deleteProject(projectId: string) {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `delete project failed with ${response.status}`);
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

function readStoredProjectId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
}

function readStoredSessionId(projectId: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage.getItem(selectedSessionStorageKey(projectId));
}

function readStoredSessionOrder(projectId: string): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(sessionOrderStorageKey(projectId));
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  } catch {
    return [];
  }
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

function promptForBranchName(): string | null {
  const provided = window.prompt("Enter a branch name for the new worktree session:");
  if (provided === null) {
    return null;
  }

  const trimmed = provided.trim();
  return trimmed || null;
}

function promptForProjectPath(): string | null {
  const provided = window.prompt("Enter an absolute project directory path:");
  if (provided === null) {
    return null;
  }

  const trimmed = provided.trim();
  return trimmed || null;
}

export function TerminalView() {
  const terminalRef = useRef<TerminalPaneHandle | null>(null);
  const queryClient = useQueryClient();

  const [connectionState, setConnectionState] = useState<TerminalConnectionState>("disconnected");
  const [terminalState, setTerminalState] = useState<TerminalStatusState>("starting");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => readStoredProjectId());
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [isProjectSectionOpen, setIsProjectSectionOpen] = useState(true);
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);
  const [projectSettingsWorktreeEnabled, setProjectSettingsWorktreeEnabled] = useState(false);
  const [projectSettingsParentPath, setProjectSettingsParentPath] = useState("");
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
    if (selectedProjectId) {
      window.sessionStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, selectedProjectId);
      setSelectedSessionId(readStoredSessionId(selectedProjectId));
      setSessionOrder(readStoredSessionOrder(selectedProjectId));
    } else {
      window.sessionStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
      setSelectedSessionId(null);
      setSessionOrder([]);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    const key = selectedSessionStorageKey(selectedProjectId);
    if (selectedSessionId) {
      window.sessionStorage.setItem(key, selectedSessionId);
    } else {
      window.sessionStorage.removeItem(key);
    }
  }, [selectedProjectId, selectedSessionId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    window.localStorage.setItem(sessionOrderStorageKey(selectedProjectId), JSON.stringify(sessionOrder));
  }, [selectedProjectId, sessionOrder]);

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 5_000,
  });

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: fetchProjects,
    refetchInterval: 5_000,
  });

  const sessionsQuery = useQuery({
    queryKey: ["sessions", selectedProjectId],
    queryFn: async () => {
      if (!selectedProjectId) {
        return [] as SessionMetadata[];
      }
      return fetchSessions(selectedProjectId);
    },
    enabled: Boolean(selectedProjectId),
    refetchInterval: 2_500,
  });

  const selectProjectMutation = useMutation({
    mutationFn: selectProject,
    onSuccess: (project) => {
      setSelectedProjectId(project.id);
      setConnectionState("disconnected");
      setTerminalState("starting");
      toast.success(`Selected project ${project.name}`);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions", project.id] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const deleteProjectMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: (deleted, projectId) => {
      if (!deleted) {
        toast.info("Project no longer exists");
      } else {
        toast.success("Project deleted");
      }

      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
      }

      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const updateProjectMutation = useMutation({
    mutationFn: updateProject,
    onSuccess: (project) => {
      toast.success(`Updated project ${project.name}`);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions", project.id] });
      setIsProjectSettingsOpen(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const createSessionMutation = useMutation({
    mutationFn: createSession,
    onSuccess: (createdSession) => {
      setSelectedSessionId(createdSession.id);
      toast.success(`Created session ${createdSession.id}`);
      void queryClient.invalidateQueries({ queryKey: ["sessions", createdSession.projectId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: (deleted, request) => {
      if (!deleted) {
        toast.info(`Session ${request.sessionId} no longer exists`);
      } else {
        toast.success(`Deleted session ${request.sessionId}`);
      }

      if (selectedSessionId === request.sessionId) {
        setSelectedSessionId(null);
      }

      void queryClient.invalidateQueries({ queryKey: ["sessions", request.projectId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const projects = projectsQuery.data ?? [];
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  useEffect(() => {
    if (!selectedProject) {
      return;
    }

    setProjectSettingsWorktreeEnabled(selectedProject.worktreeEnabled);
    setProjectSettingsParentPath(selectedProject.worktreeParentPath ?? "");
  }, [selectedProject]);

  useEffect(() => {
    if (projects.length === 0) {
      if (selectedProjectId !== null) {
        setSelectedProjectId(null);
      }
      return;
    }

    if (selectedProjectId && projects.some((project) => project.id === selectedProjectId)) {
      return;
    }

    const stored = readStoredProjectId();
    if (stored && projects.some((project) => project.id === stored)) {
      setSelectedProjectId(stored);
      return;
    }

    setSelectedProjectId(projects[0]?.id ?? null);
  }, [projects, selectedProjectId]);

  const sessions = sessionsQuery.data ?? [];
  const orderedSessions = useMemo(() => {
    if (sessions.length === 0) {
      return [];
    }

    const byId = new Map(sessions.map((session) => [session.id, session]));
    const ordered: SessionMetadata[] = [];

    for (const sessionId of sessionOrder) {
      const session = byId.get(sessionId);
      if (!session) {
        continue;
      }

      ordered.push(session);
      byId.delete(sessionId);
    }

    const remaining = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    ordered.push(...remaining);

    return ordered;
  }, [sessionOrder, sessions]);

  useEffect(() => {
    const currentIds = new Set(sessions.map((session) => session.id));
    const incomingIds = sessions.map((session) => session.id);

    setSessionOrder((previous) => {
      const retained = previous.filter((sessionId) => currentIds.has(sessionId));
      for (const sessionId of incomingIds) {
        if (!retained.includes(sessionId)) {
          retained.push(sessionId);
        }
      }

      if (retained.length === previous.length && retained.every((sessionId, index) => sessionId === previous[index])) {
        return previous;
      }

      return retained;
    });
  }, [sessions]);

  const selectedSession = useMemo(
    () => orderedSessions.find((session) => session.id === selectedSessionId) ?? null,
    [orderedSessions, selectedSessionId],
  );

  useEffect(() => {
    if (orderedSessions.length === 0) {
      if (selectedSessionId !== null) {
        setSelectedSessionId(null);
      }
      return;
    }

    if (selectedSessionId && orderedSessions.some((session) => session.id === selectedSessionId)) {
      return;
    }

    if (selectedProjectId) {
      const stored = readStoredSessionId(selectedProjectId);
      if (stored && orderedSessions.some((session) => session.id === stored)) {
        setSelectedSessionId(stored);
        return;
      }
    }

    const firstSession = orderedSessions[0];
    if (firstSession) {
      setSelectedSessionId(firstSession.id);
    }
  }, [orderedSessions, selectedProjectId, selectedSessionId]);

  useEffect(() => {
    if (!selectedSession) {
      setConnectionState("disconnected");
    }
  }, [selectedSession]);

  const handleSelectProjectPath = () => {
    const path = promptForProjectPath();
    if (!path) {
      return;
    }

    selectProjectMutation.mutate(path);
  };

  const handlePickProject = async () => {
    try {
      const path = await pickProjectPath();
      selectProjectMutation.mutate(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("PROJECT_PICK_CANCELLED")) {
        return;
      }
      toast.error(message);
    }
  };

  const handleDeleteProject = () => {
    if (!selectedProject) {
      return;
    }

    const confirmed = window.confirm(
      `Delete project '${selectedProject.name}' and all of its sessions? This will kill all tmux sessions in that project.`,
    );
    if (!confirmed) {
      return;
    }

    deleteProjectMutation.mutate(selectedProject.id);
  };

  const handleOpenProjectSettings = () => {
    if (!selectedProject) {
      toast.warning("Select a project first");
      return;
    }

    setProjectSettingsWorktreeEnabled(selectedProject.worktreeEnabled);
    setProjectSettingsParentPath(selectedProject.worktreeParentPath ?? "");
    setIsProjectSettingsOpen(true);
  };

  const handlePickWorktreeParentPath = async () => {
    try {
      const path = await pickProjectPath();
      setProjectSettingsParentPath(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("PROJECT_PICK_CANCELLED")) {
        return;
      }
      toast.error(message);
    }
  };

  const handleSaveProjectSettings = () => {
    if (!selectedProject) {
      return;
    }

    const parentPath = projectSettingsParentPath.trim();
    updateProjectMutation.mutate({
      projectId: selectedProject.id,
      worktreeEnabled: projectSettingsWorktreeEnabled,
      worktreeParentPath: parentPath ? parentPath : null,
    });
  };

  const handleCreateMainAutoSession = () => {
    if (!selectedProjectId) {
      toast.warning("Select a project first");
      return;
    }

    createSessionMutation.mutate({ projectId: selectedProjectId, mode: "main" });
  };

  const handleCreateMainNamedSession = () => {
    if (!selectedProjectId) {
      toast.warning("Select a project first");
      return;
    }

    const desiredName = promptForOptionalSessionName();
    if (desiredName === null) {
      return;
    }

    createSessionMutation.mutate({ projectId: selectedProjectId, mode: "main", name: desiredName });
  };

  const handleCreateWorktreeSession = () => {
    if (!selectedProjectId || !selectedProject) {
      toast.warning("Select a project first");
      return;
    }

    if (!selectedProject.worktreeEnabled) {
      toast.warning("Enable worktree mode in project settings first");
      return;
    }

    if (!selectedProject.worktreeParentPath) {
      toast.warning("Set a worktree parent path in project settings first");
      return;
    }

    const branchName = promptForBranchName();
    if (!branchName) {
      return;
    }

    createSessionMutation.mutate({ projectId: selectedProjectId, mode: "worktree", branchName });
  };

  const handleDeleteSession = (sessionId: string) => {
    if (!selectedProjectId) {
      return;
    }

    const confirmed = window.confirm(`Delete session '${sessionId}'? This will kill the tmux session.`);
    if (!confirmed) {
      return;
    }

    deleteSessionMutation.mutate({ projectId: selectedProjectId, sessionId });
  };

  const moveSession = (sessionId: string, direction: -1 | 1) => {
    setSessionOrder((previous) => {
      const index = previous.indexOf(sessionId);
      if (index === -1) {
        return previous;
      }

      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= previous.length) {
        return previous;
      }

      const next = [...previous];
      [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
      return next;
    });
  };

  const handleSessionUnavailable = useCallback(
    (sessionId: string, reason: SessionUnavailableReason) => {
      setSelectedSessionId((current) => (current === sessionId ? null : current));
      toast.warning(reason === "deleted" ? `Session ${sessionId} was deleted` : `Session ${sessionId} was not found`);
      if (selectedProjectId) {
        void queryClient.invalidateQueries({ queryKey: ["sessions", selectedProjectId] });
      }
    },
    [queryClient, selectedProjectId],
  );

  const connectionBadgeText = selectedSession ? connectionState : "no-session";

  return (
    <TooltipProvider delayDuration={150}>
      <main className="mx-auto flex h-[100dvh] min-h-screen w-full max-w-[1500px] flex-col gap-3 px-3 py-3 md:gap-4 md:px-6 md:py-4">
        <header className="rounded-xl border border-border bg-card/70 px-4 py-2.5 shadow-sm backdrop-blur-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="font-heading text-xl tracking-tight">Command Center</h1>

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
                projects {projects.length}
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
                <CardTitle>Control Pane</CardTitle>
                <CardDescription className="font-mono text-xs">Projects and sessions for the active workspace.</CardDescription>
              </CardHeader>

              <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                <section className="rounded-md border border-border bg-card/60 p-2">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-sm px-1 py-1 text-left"
                    onClick={() => {
                      setIsProjectSectionOpen((current) => !current);
                    }}
                  >
                    <span className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Project Management
                    </span>
                    <ChevronDown className={`h-4 w-4 transition-transform ${isProjectSectionOpen ? "rotate-0" : "-rotate-90"}`} />
                  </button>

                  {isProjectSectionOpen ? (
                    <div className="space-y-3 px-1 pb-1 pt-2">
                      <div className="space-y-1">
                        <p className="truncate font-mono text-xs font-semibold">
                          {selectedProject ? selectedProject.name : "No project selected"}
                        </p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {selectedProject ? selectedProject.path : "Pick a directory to start"}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={handlePickProject}
                          disabled={selectProjectMutation.isPending || deleteProjectMutation.isPending}
                        >
                          <FolderOpen className="h-4 w-4" />
                          Pick
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleSelectProjectPath}
                          disabled={selectProjectMutation.isPending || deleteProjectMutation.isPending}
                        >
                          Enter path
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleOpenProjectSettings}
                          disabled={!selectedProject}
                        >
                          <Settings2 className="h-4 w-4" />
                          Settings
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleDeleteProject}
                          disabled={!selectedProject || deleteProjectMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </Button>
                      </div>

                      {selectedProject ? (
                        <div className="rounded-sm border border-border/70 bg-card px-2 py-1.5">
                          <p className="font-mono text-[11px] text-muted-foreground">
                            worktree mode {selectedProject.worktreeEnabled ? "enabled" : "disabled"}
                          </p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">
                            parent {selectedProject.worktreeParentPath ?? "not set"}
                          </p>
                        </div>
                      ) : null}

                      <div className="space-y-1.5">
                        <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">Recent projects</p>
                        {projects.length === 0 ? (
                          <p className="font-mono text-[11px] text-muted-foreground">No projects yet</p>
                        ) : (
                          <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                            {projects.slice(0, 12).map((project) => {
                              const isActive = project.id === selectedProjectId;

                              return (
                                <button
                                  key={project.id}
                                  type="button"
                                  className={`w-full rounded-sm border px-2 py-1.5 text-left ${
                                    isActive ? "border-primary/60 bg-primary/10" : "border-border bg-card"
                                  }`}
                                  onClick={() => {
                                    selectProjectMutation.mutate(project.path);
                                  }}
                                >
                                  <p className="truncate font-mono text-xs font-semibold">{project.name}</p>
                                  <p className="truncate font-mono text-[11px] text-muted-foreground">{project.path}</p>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </section>

                <Separator />

                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">Session Management</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {selectedProject ? `${selectedProject.name}` : "Select a project first"}
                      </p>
                    </div>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="secondary" disabled={createSessionMutation.isPending || !selectedProjectId}>
                          <Plus className="h-4 w-4" />
                          New
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuLabel>Create Session</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={handleCreateMainAutoSession}>In main (auto name)</DropdownMenuItem>
                        <DropdownMenuItem onSelect={handleCreateMainNamedSession}>In main (custom name)</DropdownMenuItem>
                        {selectedProject?.worktreeEnabled ? (
                          <DropdownMenuItem
                            onSelect={handleCreateWorktreeSession}
                            disabled={!selectedProject.worktreeParentPath}
                          >
                            In new worktree branch
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {!selectedProjectId ? (
                    <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                      <p>Select a project path to get started.</p>
                      <Button size="sm" variant="outline" className="mt-2" onClick={handlePickProject}>
                        <FolderOpen className="h-4 w-4" />
                        Pick project
                      </Button>
                    </div>
                  ) : sessions.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                      <p>No sessions yet in this project.</p>
                      <Button size="sm" variant="outline" className="mt-2" onClick={handleCreateMainAutoSession}>
                        <Plus className="h-4 w-4" />
                        Create first session
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {orderedSessions.map((session) => {
                        const isSelected = session.id === selectedSessionId;
                        const position = sessionOrder.indexOf(session.id);
                        const canMoveUp = position > 0;
                        const canMoveDown = position !== -1 && position < sessionOrder.length - 1;

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
                                <div className="mt-1 flex items-center gap-1">
                                  <Badge
                                    variant={session.workspaceType === "worktree" ? "secondary" : "outline"}
                                    className="font-mono text-[10px] uppercase tracking-wide"
                                  >
                                    {session.workspaceType}
                                  </Badge>
                                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                                    {session.workspaceType === "worktree" ? session.workspacePath : "project root"}
                                  </span>
                                </div>
                              </button>

                              <div className="flex items-center">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-7 w-7"
                                      disabled={!canMoveUp}
                                      onClick={() => {
                                        moveSession(session.id, -1);
                                      }}
                                    >
                                      <ChevronUp className="h-4 w-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Move up</TooltipContent>
                                </Tooltip>

                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-7 w-7"
                                      disabled={!canMoveDown}
                                      onClick={() => {
                                        moveSession(session.id, 1);
                                      }}
                                    >
                                      <ChevronDown className="h-4 w-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Move down</TooltipContent>
                                </Tooltip>
                              </div>

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
                </section>

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
                {selectedSession && selectedProjectId ? (
                  <TerminalPane
                    key={`${selectedProjectId}:${selectedSession.id}`}
                    ref={terminalRef}
                    projectId={selectedProjectId}
                    sessionId={selectedSession.id}
                    onConnectionStateChange={setConnectionState}
                    onTerminalStateChange={setTerminalState}
                    onSessionUnavailable={handleSessionUnavailable}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center rounded-md border border-border/30 bg-[#1f1811] text-center text-sm text-muted-foreground">
                    <div className="space-y-2">
                      <p>{selectedProjectId ? "No session selected." : "No project selected."}</p>
                      <Button size="sm" variant="secondary" onClick={selectedProjectId ? handleCreateMainAutoSession : handlePickProject}>
                        {selectedProjectId ? <Plus className="h-4 w-4" /> : <FolderOpen className="h-4 w-4" />}
                        {selectedProjectId ? "Create session" : "Pick project"}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>

      {isProjectSettingsOpen && selectedProject ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <Card className="w-full max-w-xl border-border/80 bg-card shadow-xl">
            <CardHeader className="space-y-1 pb-3">
              <CardTitle className="text-base">Project Settings</CardTitle>
              <CardDescription className="font-mono text-xs">{selectedProject.name}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-center gap-2 rounded-md border border-border p-2">
                <input
                  type="checkbox"
                  checked={projectSettingsWorktreeEnabled}
                  onChange={(event) => {
                    setProjectSettingsWorktreeEnabled(event.currentTarget.checked);
                  }}
                />
                <span className="font-mono text-xs">Enable git worktree session mode for this project</span>
              </label>

              <div className="space-y-1.5">
                <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">Worktree parent directory</p>
                <input
                  type="text"
                  value={projectSettingsParentPath}
                  onChange={(event) => {
                    setProjectSettingsParentPath(event.currentTarget.value);
                  }}
                  placeholder="/absolute/path/for/worktrees"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-primary/60"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handlePickWorktreeParentPath}
                    disabled={updateProjectMutation.isPending}
                  >
                    <FolderOpen className="h-4 w-4" />
                    Pick folder
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setProjectSettingsParentPath("");
                    }}
                    disabled={updateProjectMutation.isPending}
                  >
                    Clear
                  </Button>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setIsProjectSettingsOpen(false);
                  }}
                  disabled={updateProjectMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSaveProjectSettings}
                  disabled={updateProjectMutation.isPending}
                >
                  Save
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </TooltipProvider>
  );
}
