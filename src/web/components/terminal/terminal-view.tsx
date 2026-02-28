import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ClipboardCheck,
  Command as CommandIcon,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Flag,
  FolderOpen,
  GitMerge,
  GitPullRequest,
  Hammer,
  MoreHorizontal,
  PauseCircle,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Maximize2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "../ui/command";
import { ConfirmDialog } from "../ui/confirm-dialog";
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
  SESSION_LIFECYCLE_LABELS,
  SESSION_LIFECYCLE_STATES,
  type SessionLifecycleState,
} from "../../../shared/session-lifecycle";
import {
  TERMINAL_ACTIONS,
  type TerminalActionConfirmation,
  type TerminalActionContext,
  type TerminalActionGroup,
  type TerminalActionId,
  type TerminalActionIcon,
  type TerminalActionInvocation,
} from "./actions";
import {
  TerminalPane,
  type SessionUnavailableReason,
  type TerminalConnectionState,
  type TerminalPaneHandle,
} from "./terminal-pane";
import type { TerminalStatusState } from "../../../shared/protocol";

const STACK_LAYOUT_BREAKPOINT_PX = 1100;
const SELECTED_PROJECT_STORAGE_KEY = "berm.selected-project-id";
const HEADER_VISIBLE_STORAGE_KEY = "berm.header-visible";
const WIDE_MODE_STORAGE_KEY = "berm.wide-mode";
const WORKSPACE_BOARD_STORAGE_KEY = "berm.workspace-board";
const MAX_WORKSPACE_SLOTS = 4;
const PALETTE_GROUP_ORDER: TerminalActionGroup[] = ["Session", "Project", "View"];

type WorkspaceLayoutMode = "single" | "split" | "quad";

type WorkspaceLayoutPreset = {
  name: string;
  layout: WorkspaceLayoutMode;
  slots: Array<string | null>;
};

type WorkspaceBoardEntry = {
  projectId: string;
  sessionId: string;
  pinnedAt: string;
};

function selectedSessionStorageKey(projectId: string) {
  return `berm.selected-session-id.${projectId}`;
}

function sessionOrderStorageKey(projectId: string) {
  return `berm.session-order.${projectId}`;
}

function workspaceLayoutStorageKey(projectId: string) {
  return `berm.workspace-layout.${projectId}`;
}

function workspaceSlotsStorageKey(projectId: string) {
  return `berm.workspace-slots.${projectId}`;
}

function workspacePresetsStorageKey(projectId: string) {
  return `berm.workspace-presets.${projectId}`;
}

type ProjectMetadata = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastUsedAt: string;
  worktreeEnabled: boolean;
  worktreeParentPath: string | null;
  worktreeHookCommand: string | null;
  worktreeHookTimeoutMs: number;
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
  lifecycleState: SessionLifecycleState;
  lifecycleUpdatedAt: string;
};

type GitHubPullRequestState = "OPEN" | "CLOSED" | "MERGED";

type SessionGitHubPrInfo = {
  number: number;
  title: string;
  url: string;
  state: GitHubPullRequestState;
  isDraft: boolean;
};

type SessionGitHubCiState = "success" | "failure" | "pending" | "none";

type SessionGitHubCiInfo = {
  state: SessionGitHubCiState;
  summary: string;
  total: number;
  passing: number;
  failing: number;
  pending: number;
};

type SessionGitHubSyncItem = {
  sessionId: string;
  branchName: string | null;
  pr: SessionGitHubPrInfo | null;
  ci: SessionGitHubCiInfo | null;
  source: "github" | "none" | "error";
  error?: string;
};

type SessionGitHubSyncResponse = {
  sessions: SessionGitHubSyncItem[];
  syncedAt: string;
  cached: boolean;
};

type WorktreeHookExecutionDetails = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  succeeded: boolean;
};

type CreateSessionResponse = {
  session: SessionMetadata;
  hook: WorktreeHookExecutionDetails | null;
};

type WorktreeHookFailurePayload = {
  code: "WORKTREE_HOOK_FAILED";
  error: string;
  decisionToken: string;
  projectId: string;
  branchName: string;
  workspacePath: string;
  hook: WorktreeHookExecutionDetails;
};

type HookOutputDialogState = {
  title: string;
  description: string;
  hook: WorktreeHookExecutionDetails;
};

type PendingActionConfirmation = {
  actionId: TerminalActionId;
  invocation: TerminalActionInvocation;
  confirmation: TerminalActionConfirmation;
};

class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload: Record<string, unknown>;

  constructor(message: string, status: number, payload: Record<string, unknown>) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = typeof payload.code === "string" ? payload.code : undefined;
    this.payload = payload;
  }
}

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

async function fetchSession(projectId: string, sessionId: string): Promise<SessionMetadata | null> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`session request failed with ${response.status}`);
  }

  return (await response.json()) as SessionMetadata;
}

async function fetchSessionGitHubSync(projectId: string): Promise<SessionGitHubSyncResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions/github-sync`);
  if (!response.ok) {
    throw new Error(`github sync request failed with ${response.status}`);
  }

  return (await response.json()) as SessionGitHubSyncResponse;
}

async function createSession(
  request:
    | { projectId: string; mode?: "main"; name?: string }
    | { projectId: string; mode: "worktree"; branchName: string },
): Promise<CreateSessionResponse> {
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

  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const errorPayload =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const message =
      typeof errorPayload.error === "string" ? errorPayload.error : `create session failed with ${response.status}`;
    throw new ApiRequestError(message, response.status, errorPayload);
  }

  if (payload && typeof payload === "object" && "session" in payload) {
    const result = payload as {
      session?: SessionMetadata;
      hook?: unknown;
    };

    if (!result.session || typeof result.session !== "object") {
      throw new Error("create session response missing session metadata");
    }

    return {
      session: result.session,
      hook: toHookExecutionDetails(result.hook),
    };
  }

  // Backward compatibility for older payload shape.
  return {
    session: payload as SessionMetadata,
    hook: null,
  };
}

async function updateProject(request: {
  projectId: string;
  worktreeEnabled?: boolean;
  worktreeParentPath?: string | null;
  worktreeHookCommand?: string | null;
  worktreeHookTimeoutMs?: number;
}) {
  const response = await fetch(`/api/projects/${encodeURIComponent(request.projectId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      worktreeEnabled: request.worktreeEnabled,
      worktreeParentPath: request.worktreeParentPath,
      worktreeHookCommand: request.worktreeHookCommand,
      worktreeHookTimeoutMs: request.worktreeHookTimeoutMs,
    }),
  });

  const payload = (await response.json()) as ProjectMetadata | { error?: string };
  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : `update project failed with ${response.status}`);
  }

  return payload as ProjectMetadata;
}

async function resolveWorktreeHookDecision(request: {
  projectId: string;
  decisionToken: string;
  decision: "abort" | "continue";
}) {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(request.projectId)}/sessions/worktree-hook-decision`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        decisionToken: request.decisionToken,
        decision: request.decision,
      }),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as
    | { action: "abort"; ok: boolean; cleaned: boolean }
    | { action: "continue"; session: SessionMetadata }
    | Record<string, unknown>;

  if (!response.ok) {
    const message =
      typeof (payload as { error?: unknown }).error === "string"
        ? ((payload as { error: string }).error)
        : `resolve hook decision failed with ${response.status}`;
    throw new ApiRequestError(message, response.status, payload as Record<string, unknown>);
  }

  return payload as { action: "abort"; ok: boolean; cleaned: boolean } | { action: "continue"; session: SessionMetadata };
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

async function updateSessionLifecycle(request: {
  projectId: string;
  sessionId: string;
  lifecycleState: SessionLifecycleState;
}) {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(request.projectId)}/sessions/${encodeURIComponent(request.sessionId)}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        lifecycleState: request.lifecycleState,
      }),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as SessionMetadata | { error?: string };
  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : `update session lifecycle failed with ${response.status}`);
  }

  return payload as SessionMetadata;
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

function lifecycleActionId(state: SessionLifecycleState): TerminalActionId {
  return `session.lifecycle.${state}`;
}

function badgeVariantForLifecycle(state: SessionLifecycleState) {
  switch (state) {
    case "planning":
    case "exploration":
      return "outline" as const;
    case "implementing":
    case "in_review":
      return "secondary" as const;
    case "submitted_pr":
      return "warning" as const;
    case "merged":
      return "success" as const;
    case "blocked":
      return "warning" as const;
    case "paused":
      return "outline" as const;
    default: {
      const neverState: never = state;
      throw new Error(`Unknown lifecycle state '${neverState as string}'`);
    }
  }
}

function badgeVariantForPullRequest(state: GitHubPullRequestState, isDraft: boolean) {
  if (state === "MERGED") {
    return "success" as const;
  }

  if (state === "OPEN" && isDraft) {
    return "secondary" as const;
  }

  if (state === "OPEN") {
    return "warning" as const;
  }

  return "outline" as const;
}

function badgeVariantForCi(state: SessionGitHubCiState) {
  if (state === "success") {
    return "success" as const;
  }
  if (state === "pending") {
    return "warning" as const;
  }
  if (state === "failure") {
    return "warning" as const;
  }
  return "outline" as const;
}

function formatRelativeDuration(isoTime: string, nowMs: number): string {
  const parsedMs = Date.parse(isoTime);
  if (Number.isNaN(parsedMs)) {
    return "unknown";
  }

  const deltaMs = Math.max(0, nowMs - parsedMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return "<1m";
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d`;
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

function readStoredHeaderVisible(): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  const stored = window.localStorage.getItem(HEADER_VISIBLE_STORAGE_KEY);
  if (stored === "false") {
    return false;
  }
  return true;
}

function readStoredWideMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(WIDE_MODE_STORAGE_KEY) === "true";
}

function readStoredWorkspaceLayout(projectId: string): WorkspaceLayoutMode {
  if (typeof window === "undefined") {
    return "single";
  }

  const raw = window.localStorage.getItem(workspaceLayoutStorageKey(projectId));
  if (raw === "split" || raw === "quad" || raw === "single") {
    return raw;
  }

  return "single";
}

function readStoredWorkspaceSlots(projectId: string): Array<string | null> {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(workspaceSlotsStorageKey(projectId));
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .slice(0, MAX_WORKSPACE_SLOTS)
      .map((value) => (typeof value === "string" && value.trim().length > 0 ? value : null));
  } catch {
    return [];
  }
}

function readStoredWorkspacePresets(projectId: string): WorkspaceLayoutPreset[] {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(workspacePresetsStorageKey(projectId));
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => {
        if (!value || typeof value !== "object") {
          return null;
        }

        const preset = value as Partial<WorkspaceLayoutPreset>;
        const layout =
          preset.layout === "single" || preset.layout === "split" || preset.layout === "quad" ? preset.layout : null;
        const name = typeof preset.name === "string" ? preset.name.trim() : "";
        if (!layout || !name) {
          return null;
        }

        const slots = Array.isArray(preset.slots)
          ? preset.slots
              .slice(0, MAX_WORKSPACE_SLOTS)
              .map((slot) => (typeof slot === "string" && slot.trim().length > 0 ? slot : null))
          : [];

        return { name, layout, slots };
      })
      .filter((preset): preset is WorkspaceLayoutPreset => preset !== null);
  } catch {
    return [];
  }
}

function readStoredWorkspaceBoard(): WorkspaceBoardEntry[] {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(WORKSPACE_BOARD_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => {
        if (!value || typeof value !== "object") {
          return null;
        }
        const entry = value as Partial<WorkspaceBoardEntry>;
        const projectId = typeof entry.projectId === "string" ? entry.projectId.trim() : "";
        const sessionId = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
        const pinnedAt = typeof entry.pinnedAt === "string" ? entry.pinnedAt : new Date().toISOString();
        if (!projectId || !sessionId) {
          return null;
        }
        return { projectId, sessionId, pinnedAt };
      })
      .filter((entry): entry is WorkspaceBoardEntry => entry !== null);
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

function hasHookOutput(hook: WorktreeHookExecutionDetails | null | undefined): boolean {
  if (!hook) {
    return false;
  }

  return hook.stdout.trim().length > 0 || hook.stderr.trim().length > 0;
}

function toHookExecutionDetails(value: unknown): WorktreeHookExecutionDetails | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.command !== "string") {
    return null;
  }

  return {
    command: record.command,
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    timedOut: record.timedOut === true,
    succeeded: record.succeeded === true,
  };
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.closest("[contenteditable='true']") !== null;
}

function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(".xterm") !== null;
}

function renderActionIcon(icon: TerminalActionIcon) {
  switch (icon) {
    case "folder":
      return <FolderOpen className="h-4 w-4" />;
    case "plus":
      return <Plus className="h-4 w-4" />;
    case "trash":
      return <Trash2 className="h-4 w-4" />;
    case "refresh":
      return <RefreshCw className="h-4 w-4" />;
    case "flag":
      return <Flag className="h-4 w-4" />;
    case "search":
      return <Search className="h-4 w-4" />;
    case "hammer":
      return <Hammer className="h-4 w-4" />;
    case "review":
      return <ClipboardCheck className="h-4 w-4" />;
    case "pr":
      return <GitPullRequest className="h-4 w-4" />;
    case "merged":
      return <GitMerge className="h-4 w-4" />;
    case "blocked":
      return <AlertTriangle className="h-4 w-4" />;
    case "paused":
      return <PauseCircle className="h-4 w-4" />;
    case "eye-open":
      return <Eye className="h-4 w-4" />;
    case "eye-closed":
      return <EyeOff className="h-4 w-4" />;
    case "expand":
      return <Maximize2 className="h-4 w-4" />;
    default: {
      const neverIcon: never = icon;
      throw new Error(`Unknown icon '${neverIcon as string}'`);
    }
  }
}

function paneCountForLayout(layout: WorkspaceLayoutMode): number {
  switch (layout) {
    case "single":
      return 1;
    case "split":
      return 2;
    case "quad":
      return 4;
    default: {
      const neverLayout: never = layout;
      throw new Error(`Unknown workspace layout '${neverLayout as string}'`);
    }
  }
}

function slotsEqual(a: Array<string | null>, b: Array<string | null>): boolean {
  for (let index = 0; index < MAX_WORKSPACE_SLOTS; index += 1) {
    if ((a[index] ?? null) !== (b[index] ?? null)) {
      return false;
    }
  }
  return true;
}

export function TerminalView() {
  const terminalRefs = useRef<Record<string, TerminalPaneHandle | null>>({});
  const commandPreviousFocusRef = useRef<HTMLElement | null>(null);
  const queryClient = useQueryClient();

  const [connectionBySessionId, setConnectionBySessionId] = useState<Record<string, TerminalConnectionState>>({});
  const [terminalStateBySessionId, setTerminalStateBySessionId] = useState<Record<string, TerminalStatusState>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => readStoredProjectId());
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [activeWorkspaceSessionId, setActiveWorkspaceSessionId] = useState<string | null>(null);
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [workspaceLayout, setWorkspaceLayout] = useState<WorkspaceLayoutMode>("single");
  const [workspaceSlots, setWorkspaceSlots] = useState<Array<string | null>>([]);
  const [workspacePresets, setWorkspacePresets] = useState<WorkspaceLayoutPreset[]>([]);
  const [workspaceBoard, setWorkspaceBoard] = useState<WorkspaceBoardEntry[]>(() => readStoredWorkspaceBoard());
  const [focusedWorkspaceSlot, setFocusedWorkspaceSlot] = useState<number | null>(null);
  const [isProjectSectionOpen, setIsProjectSectionOpen] = useState(true);
  const [isSessionSectionOpen, setIsSessionSectionOpen] = useState(true);
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);
  const [projectSettingsWorktreeEnabled, setProjectSettingsWorktreeEnabled] = useState(false);
  const [projectSettingsParentPath, setProjectSettingsParentPath] = useState("");
  const [projectSettingsHookCommand, setProjectSettingsHookCommand] = useState("");
  const [projectSettingsHookTimeoutMs, setProjectSettingsHookTimeoutMs] = useState("15000");
  const [worktreeHookFailure, setWorktreeHookFailure] = useState<WorktreeHookFailurePayload | null>(null);
  const [hookOutputDialog, setHookOutputDialog] = useState<HookOutputDialogState | null>(null);
  const [isWideMode, setIsWideMode] = useState(() => readStoredWideMode());
  const [isHeaderVisible, setIsHeaderVisible] = useState(() => readStoredHeaderVisible());
  const [isStackedLayout, setIsStackedLayout] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.matchMedia(`(max-width: ${STACK_LAYOUT_BREAKPOINT_PX}px)`).matches;
  });
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pendingActionConfirmation, setPendingActionConfirmation] = useState<PendingActionConfirmation | null>(null);
  const commandHotkeyLabel = useMemo(() => {
    if (typeof navigator === "undefined") {
      return "Ctrl+K";
    }
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘K" : "Ctrl+K";
  }, []);

  const rememberCommandFocusTarget = useCallback(() => {
    if (typeof document === "undefined") {
      return;
    }

    const activeElement = document.activeElement;
    commandPreviousFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
  }, []);

  const restoreCommandFocusTarget = useCallback(() => {
    const target = commandPreviousFocusRef.current;
    commandPreviousFocusRef.current = null;

    if (!target || !target.isConnected) {
      return;
    }

    window.requestAnimationFrame(() => {
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    });
  }, []);

  const openCommandPalette = useCallback(() => {
    rememberCommandFocusTarget();
    setIsCommandOpen(true);
  }, [rememberCommandFocusTarget]);

  const closeCommandPalette = useCallback((options?: { restoreFocus?: boolean }) => {
    setIsCommandOpen(false);
    if (options?.restoreFocus ?? true) {
      restoreCommandFocusTarget();
    }
  }, [restoreCommandFocusTarget]);

  const handleCommandOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        if (!isCommandOpen) {
          rememberCommandFocusTarget();
          setIsCommandOpen(true);
        }
        return;
      }

      if (isCommandOpen) {
        closeCommandPalette();
      } else {
        restoreCommandFocusTarget();
      }
    },
    [closeCommandPalette, isCommandOpen, rememberCommandFocusTarget, restoreCommandFocusTarget],
  );

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
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      window.sessionStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, selectedProjectId);
      setSelectedSessionId(readStoredSessionId(selectedProjectId));
      setSessionOrder(readStoredSessionOrder(selectedProjectId));
      setWorkspaceLayout(readStoredWorkspaceLayout(selectedProjectId));
      setWorkspaceSlots(readStoredWorkspaceSlots(selectedProjectId));
      setWorkspacePresets(readStoredWorkspacePresets(selectedProjectId));
    } else {
      window.sessionStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
      setSelectedSessionId(null);
      setSessionOrder([]);
      setWorkspaceLayout("single");
      setWorkspaceSlots([]);
      setWorkspacePresets([]);
    }
    setFocusedWorkspaceSlot(null);
    setActiveWorkspaceSessionId(null);
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

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    window.localStorage.setItem(workspaceLayoutStorageKey(selectedProjectId), workspaceLayout);
  }, [selectedProjectId, workspaceLayout]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    window.localStorage.setItem(workspaceSlotsStorageKey(selectedProjectId), JSON.stringify(workspaceSlots));
  }, [selectedProjectId, workspaceSlots]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    window.localStorage.setItem(workspacePresetsStorageKey(selectedProjectId), JSON.stringify(workspacePresets));
  }, [selectedProjectId, workspacePresets]);

  useEffect(() => {
    window.localStorage.setItem(WORKSPACE_BOARD_STORAGE_KEY, JSON.stringify(workspaceBoard));
  }, [workspaceBoard]);

  useEffect(() => {
    window.localStorage.setItem(HEADER_VISIBLE_STORAGE_KEY, isHeaderVisible ? "true" : "false");
  }, [isHeaderVisible]);

  useEffect(() => {
    window.localStorage.setItem(WIDE_MODE_STORAGE_KEY, isWideMode ? "true" : "false");
  }, [isWideMode]);

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

  const sessionGitHubSyncQuery = useQuery({
    queryKey: ["sessions-github-sync", selectedProjectId],
    queryFn: async () => {
      if (!selectedProjectId) {
        return { sessions: [], syncedAt: new Date(0).toISOString(), cached: false } as SessionGitHubSyncResponse;
      }
      return fetchSessionGitHubSync(selectedProjectId);
    },
    enabled: Boolean(selectedProjectId),
    refetchInterval: 20_000,
  });

  const selectProjectMutation = useMutation({
    mutationFn: selectProject,
    onSuccess: (project) => {
      setSelectedProjectId(project.id);
      toast.success(`Selected project ${project.name}`);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions", project.id] });
      void queryClient.invalidateQueries({ queryKey: ["sessions-github-sync", project.id] });
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
      void queryClient.invalidateQueries({ queryKey: ["sessions-github-sync"] });
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
      void queryClient.invalidateQueries({ queryKey: ["sessions-github-sync", project.id] });
      setIsProjectSettingsOpen(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const createSessionMutation = useMutation({
    mutationFn: createSession,
    onSuccess: (created, request) => {
      setSelectedSessionId(created.session.id);
      setWorktreeHookFailure(null);
      toast.success(`Created session ${created.session.id}`);

      if (request.mode === "worktree" && created.hook?.succeeded) {
        if (hasHookOutput(created.hook)) {
          toast.success("Worktree hook completed successfully", {
            action: {
              label: "View output",
              onClick: () => {
                setHookOutputDialog({
                  title: "Worktree Hook Output",
                  description: `Branch ${created.session.branchName ?? created.session.id} completed successfully`,
                  hook: created.hook!,
                });
              },
            },
          });
        } else {
          toast.success("Worktree hook completed successfully");
        }
      }
      void queryClient.invalidateQueries({ queryKey: ["sessions", created.session.projectId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions-github-sync", created.session.projectId] });
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.code === "WORKTREE_HOOK_FAILED") {
        const payload = error.payload as Partial<WorktreeHookFailurePayload>;
        const hook = toHookExecutionDetails(payload.hook);
        if (
          typeof payload.decisionToken === "string" &&
          typeof payload.projectId === "string" &&
          typeof payload.branchName === "string" &&
          typeof payload.workspacePath === "string" &&
          hook
        ) {
          setWorktreeHookFailure({
            code: "WORKTREE_HOOK_FAILED",
            error: typeof payload.error === "string" ? payload.error : error.message,
            decisionToken: payload.decisionToken,
            projectId: payload.projectId,
            branchName: payload.branchName,
            workspacePath: payload.workspacePath,
            hook,
          });
          if (hasHookOutput(hook)) {
            toast.warning("Worktree hook failed. Choose whether to continue or abort.", {
              action: {
                label: "View output",
                onClick: () => {
                  setHookOutputDialog({
                    title: "Worktree Hook Output",
                    description: `Branch ${payload.branchName} failed`,
                    hook,
                  });
                },
              },
            });
          } else {
            toast.warning("Worktree hook failed. Choose whether to continue or abort.");
          }
          return;
        }
      }

      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const resolveWorktreeHookDecisionMutation = useMutation({
    mutationFn: resolveWorktreeHookDecision,
    onSuccess: (result, request) => {
      if (result.action === "continue") {
        if (selectedProjectId !== result.session.projectId) {
          setSelectedProjectId(result.session.projectId);
        }
        setSelectedSessionId(result.session.id);
        toast.success(`Created session ${result.session.id} after hook failure`);
        void queryClient.invalidateQueries({ queryKey: ["sessions", result.session.projectId] });
        void queryClient.invalidateQueries({ queryKey: ["sessions-github-sync", result.session.projectId] });
      } else {
        toast.message("Worktree setup aborted and cleaned up");
        void queryClient.invalidateQueries({ queryKey: ["sessions", request.projectId] });
        void queryClient.invalidateQueries({ queryKey: ["sessions-github-sync", request.projectId] });
      }

      setWorktreeHookFailure(null);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error) => {
      if (
        error instanceof ApiRequestError &&
        (error.code === "WORKTREE_HOOK_DECISION_NOT_FOUND" || error.code === "WORKTREE_HOOK_DECISION_INVALID")
      ) {
        setWorktreeHookFailure(null);
      }
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
      void queryClient.invalidateQueries({ queryKey: ["sessions-github-sync", request.projectId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const updateSessionLifecycleMutation = useMutation({
    mutationFn: updateSessionLifecycle,
    onSuccess: (session) => {
      toast.success(`Session ${session.id}: ${SESSION_LIFECYCLE_LABELS[session.lifecycleState]}`);
      void queryClient.invalidateQueries({ queryKey: ["sessions", session.projectId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions-github-sync", session.projectId] });
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
  const workspaceBoardItems = useMemo(() => {
    return workspaceBoard
      .map((entry) => ({
        ...entry,
        project: projects.find((project) => project.id === entry.projectId) ?? null,
      }))
      .sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt));
  }, [projects, workspaceBoard]);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }

    setProjectSettingsWorktreeEnabled(selectedProject.worktreeEnabled);
    setProjectSettingsParentPath(selectedProject.worktreeParentPath ?? "");
    setProjectSettingsHookCommand(selectedProject.worktreeHookCommand ?? "");
    setProjectSettingsHookTimeoutMs(String(selectedProject.worktreeHookTimeoutMs ?? 15_000));
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

  useEffect(() => {
    const validProjectIds = new Set(projects.map((project) => project.id));
    setWorkspaceBoard((previous) => {
      const filtered = previous.filter((entry) => validProjectIds.has(entry.projectId));
      if (filtered.length === previous.length) {
        return previous;
      }
      return filtered;
    });
  }, [projects]);

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
  const sessionById = useMemo(() => {
    return new Map(orderedSessions.map((session) => [session.id, session]));
  }, [orderedSessions]);
  const sessionGitHubSyncById = useMemo(() => {
    const entries = sessionGitHubSyncQuery.data?.sessions ?? [];
    return new Map(entries.map((entry) => [entry.sessionId, entry]));
  }, [sessionGitHubSyncQuery.data]);
  const workspacePaneCount = paneCountForLayout(workspaceLayout);
  const resolvedWorkspaceSlots = useMemo(() => {
    const next: Array<string | null> = Array.from({ length: MAX_WORKSPACE_SLOTS }, () => null);
    const seen = new Set<string>();

    for (let index = 0; index < MAX_WORKSPACE_SLOTS; index += 1) {
      const slotSessionId = workspaceSlots[index] ?? null;
      if (!slotSessionId || !sessionById.has(slotSessionId) || seen.has(slotSessionId)) {
        continue;
      }

      next[index] = slotSessionId;
      seen.add(slotSessionId);
    }

    for (const session of orderedSessions) {
      if (seen.has(session.id)) {
        continue;
      }

      const firstEmpty = next.findIndex((value) => value === null);
      if (firstEmpty === -1) {
        break;
      }

      next[firstEmpty] = session.id;
      seen.add(session.id);
    }

    return next;
  }, [orderedSessions, sessionById, workspaceSlots]);
  const visibleWorkspaceSlotIndexes = useMemo(() => {
    const focusedSlotHasSession =
      focusedWorkspaceSlot !== null &&
      focusedWorkspaceSlot < workspacePaneCount &&
      Boolean(resolvedWorkspaceSlots[focusedWorkspaceSlot]);

    if (focusedSlotHasSession && focusedWorkspaceSlot !== null) {
      return [focusedWorkspaceSlot];
    }

    return Array.from({ length: workspacePaneCount }, (_unused, index) => index);
  }, [focusedWorkspaceSlot, resolvedWorkspaceSlots, workspacePaneCount]);
  const activeVisibleSlotIndex = useMemo(() => {
    const findSlotBySessionId = (sessionId: string | null) => {
      if (!sessionId) {
        return -1;
      }
      return visibleWorkspaceSlotIndexes.findIndex(
        (slotIndex) => (resolvedWorkspaceSlots[slotIndex] ?? null) === sessionId,
      );
    };

    const activeIndex = findSlotBySessionId(activeWorkspaceSessionId);
    if (activeIndex >= 0) {
      return visibleWorkspaceSlotIndexes[activeIndex] ?? 0;
    }

    const selectedIndex = findSlotBySessionId(selectedSessionId);
    if (selectedIndex >= 0) {
      return visibleWorkspaceSlotIndexes[selectedIndex] ?? 0;
    }

    const populatedIndex = visibleWorkspaceSlotIndexes.find(
      (slotIndex) => Boolean(resolvedWorkspaceSlots[slotIndex] ?? null),
    );
    if (typeof populatedIndex === "number") {
      return populatedIndex;
    }

    return visibleWorkspaceSlotIndexes[0] ?? 0;
  }, [activeWorkspaceSessionId, resolvedWorkspaceSlots, selectedSessionId, visibleWorkspaceSlotIndexes]);
  const activeVisibleSlotSessionId = resolvedWorkspaceSlots[activeVisibleSlotIndex] ?? null;
  const actionTargetSessionId = activeVisibleSlotSessionId ?? activeWorkspaceSessionId ?? selectedSessionId;
  const actionTargetSession = useMemo(
    () => (actionTargetSessionId ? (sessionById.get(actionTargetSessionId) ?? null) : null),
    [actionTargetSessionId, sessionById],
  );
  const selectedConnectionState = selectedSession
    ? (connectionBySessionId[selectedSession.id] ?? "disconnected")
    : "disconnected";
  const selectedTerminalState = selectedSession ? (terminalStateBySessionId[selectedSession.id] ?? "starting") : "starting";

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
    const validSessionIds = new Set(orderedSessions.map((session) => session.id));
    setActiveWorkspaceSessionId((current) => {
      if (current && validSessionIds.has(current)) {
        return current;
      }
      if (selectedSessionId && validSessionIds.has(selectedSessionId)) {
        return selectedSessionId;
      }
      return orderedSessions[0]?.id ?? null;
    });
  }, [orderedSessions, selectedSessionId]);

  useEffect(() => {
    const validSessionIds = new Set(orderedSessions.map((session) => session.id));

    setConnectionBySessionId((previous) => {
      const entries = Object.entries(previous).filter(([sessionId]) => validSessionIds.has(sessionId));
      if (entries.length === Object.keys(previous).length) {
        return previous;
      }
      return Object.fromEntries(entries);
    });

    setTerminalStateBySessionId((previous) => {
      const entries = Object.entries(previous).filter(([sessionId]) => validSessionIds.has(sessionId));
      if (entries.length === Object.keys(previous).length) {
        return previous;
      }
      return Object.fromEntries(entries);
    });
  }, [orderedSessions]);

  useEffect(() => {
    if (orderedSessions.length === 0) {
      setWorkspaceSlots((previous) => (previous.length === 0 ? previous : []));
      return;
    }

    const validSessionIds = new Set(orderedSessions.map((session) => session.id));
    setWorkspaceSlots((previous) => {
      const next = Array.from({ length: MAX_WORKSPACE_SLOTS }, (_unused, index) => {
        const sessionId = previous[index] ?? null;
        if (!sessionId || !validSessionIds.has(sessionId)) {
          return null;
        }
        return sessionId;
      });

      const seen = new Set<string>();
      for (let index = 0; index < next.length; index += 1) {
        const sessionId = next[index];
        if (!sessionId) {
          continue;
        }
        if (seen.has(sessionId)) {
          next[index] = null;
          continue;
        }
        seen.add(sessionId);
      }

      if (!next.some((sessionId) => sessionId !== null) && orderedSessions[0]) {
        next[0] = orderedSessions[0].id;
      }

      if (slotsEqual(next, previous)) {
        return previous;
      }

      return next;
    });
  }, [orderedSessions]);

  useEffect(() => {
    const maxPaneIndex = workspacePaneCount - 1;
    setFocusedWorkspaceSlot((current) => (current !== null && current > maxPaneIndex ? null : current));
  }, [workspacePaneCount]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey) {
        return;
      }

      if (isCommandOpen) {
        event.preventDefault();
        closeCommandPalette();
        return;
      }

      if (isTextEntryTarget(event.target) && !isTerminalTarget(event.target)) {
        return;
      }

      event.preventDefault();
      openCommandPalette();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [closeCommandPalette, isCommandOpen, openCommandPalette]);

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

  const deleteProjectById = (projectId: string) => {
    deleteProjectMutation.mutate(projectId);
  };

  const handleOpenProjectSettings = () => {
    if (!selectedProject) {
      toast.warning("Select a project first");
      return;
    }

    setProjectSettingsWorktreeEnabled(selectedProject.worktreeEnabled);
    setProjectSettingsParentPath(selectedProject.worktreeParentPath ?? "");
    setProjectSettingsHookCommand(selectedProject.worktreeHookCommand ?? "");
    setProjectSettingsHookTimeoutMs(String(selectedProject.worktreeHookTimeoutMs ?? 15_000));
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
    const hookCommand = projectSettingsHookCommand.trim();
    const parsedTimeout = Number(projectSettingsHookTimeoutMs.trim());
    if (
      !Number.isFinite(parsedTimeout) ||
      Math.floor(parsedTimeout) !== parsedTimeout ||
      parsedTimeout < 1_000 ||
      parsedTimeout > 120_000
    ) {
      toast.error("Hook timeout must be an integer between 1000 and 120000 milliseconds");
      return;
    }

    updateProjectMutation.mutate({
      projectId: selectedProject.id,
      worktreeEnabled: projectSettingsWorktreeEnabled,
      worktreeParentPath: parentPath ? parentPath : null,
      worktreeHookCommand: hookCommand ? hookCommand : null,
      worktreeHookTimeoutMs: parsedTimeout,
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

  const deleteSessionById = (request: { projectId: string; sessionId: string }) => {
    deleteSessionMutation.mutate(request);
  };

  const setSessionLifecycleStateById = (request: {
    projectId: string;
    sessionId: string;
    lifecycleState: SessionLifecycleState;
  }) => {
    updateSessionLifecycleMutation.mutate(request);
  };

  const handleWorktreeHookDecision = (decision: "abort" | "continue") => {
    if (!worktreeHookFailure) {
      return;
    }

    resolveWorktreeHookDecisionMutation.mutate({
      projectId: worktreeHookFailure.projectId,
      decisionToken: worktreeHookFailure.decisionToken,
      decision,
    });
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

  const addSessionToWorkspace = useCallback((sessionId: string) => {
    setWorkspaceSlots((previous) => {
      if (previous.includes(sessionId)) {
        return previous;
      }

      const next = Array.from({ length: MAX_WORKSPACE_SLOTS }, (_unused, index) => previous[index] ?? null);
      const firstEmpty = next.findIndex((value) => value === null);
      if (firstEmpty >= 0) {
        next[firstEmpty] = sessionId;
      } else {
        next[0] = sessionId;
      }
      return next;
    });
  }, []);

  const workspaceBoardKey = useCallback((entry: Pick<WorkspaceBoardEntry, "projectId" | "sessionId">) => {
    return `${entry.projectId}::${entry.sessionId}`;
  }, []);

  const isSessionPinned = useCallback(
    (projectId: string, sessionId: string) => {
      return workspaceBoard.some((entry) => entry.projectId === projectId && entry.sessionId === sessionId);
    },
    [workspaceBoard],
  );

  const pinSessionToWorkspaceBoard = useCallback((projectId: string, sessionId: string) => {
    setWorkspaceBoard((previous) => {
      if (previous.some((entry) => entry.projectId === projectId && entry.sessionId === sessionId)) {
        return previous;
      }

      return [
        ...previous,
        {
          projectId,
          sessionId,
          pinnedAt: new Date().toISOString(),
        },
      ];
    });
    toast.success(`Pinned ${sessionId} to workspace board`);
  }, []);

  const unpinSessionFromWorkspaceBoard = useCallback(
    (projectId: string, sessionId: string, options?: { silent?: boolean }) => {
      setWorkspaceBoard((previous) => {
        const next = previous.filter((entry) => !(entry.projectId === projectId && entry.sessionId === sessionId));
        if (next.length === previous.length) {
          return previous;
        }
        return next;
      });
      if (!options?.silent) {
        toast.message(`Removed ${sessionId} from workspace board`);
      }
    },
    [],
  );

  const openWorkspaceBoardEntry = useCallback(
    async (entry: WorkspaceBoardEntry) => {
      const metadata = await fetchSession(entry.projectId, entry.sessionId);
      if (!metadata) {
        unpinSessionFromWorkspaceBoard(entry.projectId, entry.sessionId, { silent: true });
        toast.warning(`Pinned session ${entry.sessionId} no longer exists`);
        return;
      }

      setSelectedProjectId(entry.projectId);
      setSelectedSessionId(entry.sessionId);
      toast.success(`Opened ${entry.sessionId}`);
    },
    [unpinSessionFromWorkspaceBoard],
  );

  const setWorkspaceSlotSession = useCallback((slotIndex: number, sessionId: string | null) => {
    setWorkspaceSlots((previous) => {
      const next = Array.from({ length: MAX_WORKSPACE_SLOTS }, (_unused, index) => previous[index] ?? null);
      next[slotIndex] = sessionId;

      for (let index = 0; index < next.length; index += 1) {
        if (index === slotIndex) {
          continue;
        }
        if (next[index] === sessionId) {
          next[index] = null;
        }
      }

      if (slotsEqual(next, previous)) {
        return previous;
      }

      return next;
    });
  }, []);

  const activateSessionFromSessionList = useCallback(
    (sessionId: string) => {
      const visibleSlot = visibleWorkspaceSlotIndexes.find(
        (slotIndex) => (resolvedWorkspaceSlots[slotIndex] ?? null) === sessionId,
      );
      if (typeof visibleSlot === "number") {
        setSelectedSessionId(sessionId);
        setActiveWorkspaceSessionId(sessionId);
        return;
      }

      setWorkspaceSlotSession(activeVisibleSlotIndex, sessionId);
      setSelectedSessionId(sessionId);
      setActiveWorkspaceSessionId(sessionId);
    },
    [activeVisibleSlotIndex, resolvedWorkspaceSlots, setWorkspaceSlotSession, visibleWorkspaceSlotIndexes],
  );

  const saveWorkspacePreset = useCallback(() => {
    const provided = window.prompt("Save workspace layout as:");
    if (provided === null) {
      return;
    }

    const name = provided.trim();
    if (!name) {
      toast.warning("Preset name cannot be empty");
      return;
    }

    const preset: WorkspaceLayoutPreset = {
      name,
      layout: workspaceLayout,
      slots: resolvedWorkspaceSlots,
    };

    setWorkspacePresets((previous) => {
      const withoutExisting = previous.filter((entry) => entry.name.toLowerCase() !== name.toLowerCase());
      return [...withoutExisting, preset].sort((a, b) => a.name.localeCompare(b.name));
    });
    toast.success(`Saved workspace preset '${name}'`);
  }, [resolvedWorkspaceSlots, workspaceLayout]);

  const loadWorkspacePreset = useCallback((preset: WorkspaceLayoutPreset) => {
    setWorkspaceLayout(preset.layout);
    setWorkspaceSlots(preset.slots);
    setFocusedWorkspaceSlot(null);
    toast.success(`Loaded workspace preset '${preset.name}'`);
  }, []);

  const handleSessionUnavailable = useCallback(
    (sessionId: string, reason: SessionUnavailableReason) => {
      setSelectedSessionId((current) => (current === sessionId ? null : current));
      setWorkspaceSlots((previous) => previous.map((slotSessionId) => (slotSessionId === sessionId ? null : slotSessionId)));
      toast.warning(reason === "deleted" ? `Session ${sessionId} was deleted` : `Session ${sessionId} was not found`);
      if (selectedProjectId) {
        void queryClient.invalidateQueries({ queryKey: ["sessions", selectedProjectId] });
        void queryClient.invalidateQueries({ queryKey: ["sessions-github-sync", selectedProjectId] });
      }
    },
    [queryClient, selectedProjectId],
  );

  const reconnectSelectedSession = useCallback(() => {
    if (!actionTargetSession) {
      return;
    }

    terminalRefs.current[actionTargetSession.id]?.reconnect();
    toast.info("Reconnecting socket...");
  }, [actionTargetSession]);

  const actionContext = useMemo<TerminalActionContext>(
    () => ({
      selectedProjectId,
      selectedProjectName: selectedProject?.name ?? null,
      selectedSessionId: actionTargetSession?.id ?? null,
      selectedSessionName: actionTargetSession?.id ?? null,
      selectedSessionLifecycleState: actionTargetSession?.lifecycleState ?? null,
      isWideMode,
      isHeaderVisible,
      pending: {
        pickProject: selectProjectMutation.isPending,
        createSession: createSessionMutation.isPending,
        deleteProject: deleteProjectMutation.isPending,
        deleteSession: deleteSessionMutation.isPending,
        updateSessionLifecycle: updateSessionLifecycleMutation.isPending,
      },
    }),
    [
      createSessionMutation.isPending,
      deleteProjectMutation.isPending,
      deleteSessionMutation.isPending,
      isHeaderVisible,
      isWideMode,
      selectedProject,
      selectedProjectId,
      actionTargetSession,
      selectProjectMutation.isPending,
      updateSessionLifecycleMutation.isPending,
    ],
  );

  const actionsById = useMemo(() => {
    return new Map(TERMINAL_ACTIONS.map((action) => [action.id, action]));
  }, []);

  const actionsByGroup = useMemo(() => {
    return PALETTE_GROUP_ORDER.map((group) => ({
      group,
      actions: TERMINAL_ACTIONS.filter((action) => action.group === group),
    })).filter((entry) => entry.actions.length > 0);
  }, []);

  const actionHandlers = {
    pickProject: () => {
      void handlePickProject();
    },
    createSessionAuto: handleCreateMainAutoSession,
    createSessionCustom: handleCreateMainNamedSession,
    deleteProject: deleteProjectById,
    deleteSession: deleteSessionById,
    reconnectSession: reconnectSelectedSession,
    setSessionLifecycleState: setSessionLifecycleStateById,
    toggleWideMode: () => {
      setIsWideMode((current) => !current);
    },
    hideHeader: () => {
      setIsHeaderVisible(false);
    },
    showHeader: () => {
      setIsHeaderVisible(true);
    },
  };

  const getActionAvailability = (actionId: TerminalActionId, invocation: TerminalActionInvocation) => {
    const action = actionsById.get(actionId);
    if (!action) {
      return { enabled: false, disabledReason: `Unknown action '${actionId}'` };
    }

    return action.getAvailability(actionContext, invocation);
  };

  const runAction = (
    actionId: TerminalActionId,
    invocation: TerminalActionInvocation = { source: "button" },
    options?: { skipConfirmation?: boolean; suppressUnavailableToast?: boolean },
  ) => {
    const action = actionsById.get(actionId);
    if (!action) {
      toast.error(`Unknown action '${actionId}'`);
      return;
    }

    const availability = action.getAvailability(actionContext, invocation);
    if (!availability.enabled) {
      if (!options?.suppressUnavailableToast) {
        toast.warning(availability.disabledReason ?? `${action.label} is unavailable`);
      }
      return;
    }

    const confirmation =
      !options?.skipConfirmation && action.getConfirmation
        ? action.getConfirmation(actionContext, invocation)
        : null;
    if (!options?.skipConfirmation && action.getConfirmation) {
      if (confirmation) {
        if (invocation.source === "palette" && isCommandOpen) {
          closeCommandPalette({ restoreFocus: false });
        }
        setPendingActionConfirmation({ actionId, invocation, confirmation });
        return;
      }
    }

    if (invocation.source === "palette" && isCommandOpen && !confirmation) {
      closeCommandPalette();
    }

    try {
      action.run(actionContext, actionHandlers, invocation);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const isConfirmationPending =
    pendingActionConfirmation?.actionId === "project.delete.current"
      ? deleteProjectMutation.isPending
      : pendingActionConfirmation?.actionId === "session.delete.current"
        ? deleteSessionMutation.isPending
        : false;

  const handleConfirmPendingAction = () => {
    if (!pendingActionConfirmation) {
      return;
    }

    const nextAction = pendingActionConfirmation;
    setPendingActionConfirmation(null);
    runAction(nextAction.actionId, nextAction.invocation, { skipConfirmation: true, suppressUnavailableToast: true });
    if (nextAction.invocation.source === "palette") {
      restoreCommandFocusTarget();
    }
  };

  const workspaceItems = useMemo(() => {
    return resolvedWorkspaceSlots.slice(0, workspacePaneCount).map((sessionId, slotIndex) => ({
      slotIndex,
      session: sessionId ? (sessionById.get(sessionId) ?? null) : null,
    }));
  }, [resolvedWorkspaceSlots, sessionById, workspacePaneCount]);

  const focusedWorkspaceItem =
    focusedWorkspaceSlot !== null && focusedWorkspaceSlot < workspaceItems.length ? workspaceItems[focusedWorkspaceSlot] : null;
  const displayedWorkspaceItems =
    focusedWorkspaceItem && focusedWorkspaceItem.session ? [focusedWorkspaceItem] : workspaceItems;
  const workspaceGridClass =
    displayedWorkspaceItems.length <= 1
      ? "grid h-full min-h-0 grid-cols-1 gap-2"
      : displayedWorkspaceItems.length === 2
        ? "grid h-full min-h-0 grid-cols-1 gap-2 lg:grid-cols-2"
        : "grid h-full min-h-0 grid-cols-1 gap-2 lg:grid-cols-2";

  const connectionBadgeText = selectedSession ? selectedConnectionState : "no-session";
  const mainLayoutClass = isWideMode
    ? "mx-auto flex h-[100dvh] min-h-screen w-full max-w-none flex-col gap-3 px-2 py-3 md:gap-4 md:px-2 md:py-4"
    : "mx-auto flex h-[100dvh] min-h-screen w-full max-w-[1500px] flex-col gap-3 px-3 py-3 md:gap-4 md:px-6 md:py-4";

  return (
    <TooltipProvider delayDuration={150}>
      <main className={mainLayoutClass}>
        {isHeaderVisible ? (
          <header className="rounded-xl border border-border bg-card/70 px-4 py-2.5 shadow-sm backdrop-blur-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="font-heading text-xl tracking-tight">Berm</h1>

              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={badgeVariantForConnection(selectedConnectionState)} className="font-mono uppercase tracking-wide">
                  {connectionBadgeText}
                </Badge>
                <Badge variant="secondary" className="font-mono uppercase tracking-wide">
                  {selectedTerminalState}
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
        ) : null}

        <ResizablePanelGroup
          key={isStackedLayout ? "stacked" : "split"}
          direction={isStackedLayout ? "vertical" : "horizontal"}
          className="min-h-0 flex-1 rounded-xl border border-border bg-card/40"
        >
          <ResizablePanel defaultSize={isStackedLayout ? 36 : 28} minSize={isStackedLayout ? 25 : 20} className="min-h-0">
            <Card className="flex h-full min-h-0 flex-col rounded-none border-0 bg-transparent shadow-none">
              <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
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
                          onClick={() => {
                            runAction("project.new.pick", { source: "button" }, { suppressUnavailableToast: true });
                          }}
                          disabled={!getActionAvailability("project.new.pick", { source: "button" }).enabled}
                        >
                          <FolderOpen className="h-4 w-4" />
                          Pick
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
                          onClick={() => {
                            runAction("project.delete.current", { source: "button" });
                          }}
                          disabled={!getActionAvailability("project.delete.current", { source: "button" }).enabled}
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
                          <p className="truncate font-mono text-[11px] text-muted-foreground">
                            hook {selectedProject.worktreeHookCommand ? "configured" : "not set"} · timeout{" "}
                            {selectedProject.worktreeHookTimeoutMs}ms
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

                <section className="rounded-md border border-border bg-card/60 p-2">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-sm px-1 py-1 text-left"
                    onClick={() => {
                      setIsSessionSectionOpen((current) => !current);
                    }}
                  >
                    <span className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Session Management
                    </span>
                    <ChevronDown className={`h-4 w-4 transition-transform ${isSessionSectionOpen ? "rotate-0" : "-rotate-90"}`} />
                  </button>

                  {isSessionSectionOpen ? (
                    <div className="space-y-3 px-1 pb-1 pt-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-mono text-[11px] text-muted-foreground">
                            {selectedProject ? `${selectedProject.name}` : "Select a project first"}
                          </p>
                        </div>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={!getActionAvailability("session.new.auto", { source: "dropdown" }).enabled}
                            >
                              <Plus className="h-4 w-4" />
                              New
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuLabel>Create Session</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => {
                                runAction("session.new.auto", { source: "dropdown" });
                              }}
                              disabled={!getActionAvailability("session.new.auto", { source: "dropdown" }).enabled}
                            >
                              In main (auto name)
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                runAction("session.new.custom", { source: "dropdown" });
                              }}
                              disabled={!getActionAvailability("session.new.custom", { source: "dropdown" }).enabled}
                            >
                              In main (custom name)
                            </DropdownMenuItem>
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
                          <Button
                            size="sm"
                            variant="outline"
                            className="mt-2"
                            onClick={() => {
                              runAction("project.new.pick", { source: "fallback" }, { suppressUnavailableToast: true });
                            }}
                          >
                            <FolderOpen className="h-4 w-4" />
                            Pick project
                          </Button>
                        </div>
                      ) : sessions.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                          <p>No sessions yet in this project.</p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="mt-2"
                            onClick={() => {
                              runAction("session.new.auto", { source: "fallback" });
                            }}
                          >
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
                            const canDeleteSession = getActionAvailability("session.delete.current", {
                              source: "row",
                              projectId: selectedProjectId ?? undefined,
                              sessionId: session.id,
                            }).enabled;
                            const sessionSync = sessionGitHubSyncById.get(session.id) ?? null;
                            const isPinned = isSessionPinned(session.projectId, session.id);

                            return (
                              <div
                                key={session.id}
                                className={`rounded-md border p-2 transition-colors ${
                                  isSelected ? "border-primary/60 bg-primary/10" : "border-border bg-card/60"
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    className="min-w-0 flex-1 text-left"
                                    onClick={() => {
                                      activateSessionFromSessionList(session.id);
                                    }}
                                  >
                                    <p className="truncate font-mono text-sm font-semibold">{session.id}</p>
                                    <p className="font-mono text-[11px] text-muted-foreground">
                                      active {new Date(session.lastActiveAt).toLocaleTimeString()} · clients {session.attachedClients}
                                    </p>
                                    <div className="mt-1 flex flex-wrap items-center gap-1">
                                      <Badge
                                        variant={session.workspaceType === "worktree" ? "secondary" : "outline"}
                                        className="font-mono text-[10px] uppercase tracking-wide"
                                      >
                                        {session.workspaceType}
                                      </Badge>
                                      {sessionSync?.pr ? (
                                        <Badge
                                          variant={badgeVariantForPullRequest(sessionSync.pr.state, sessionSync.pr.isDraft)}
                                          className="font-mono text-[10px] uppercase tracking-wide"
                                        >
                                          PR #{sessionSync.pr.number}{" "}
                                          {sessionSync.pr.state === "OPEN"
                                            ? sessionSync.pr.isDraft
                                              ? "draft"
                                              : "open"
                                            : sessionSync.pr.state.toLowerCase()}
                                        </Badge>
                                      ) : null}
                                      {sessionSync?.ci ? (
                                        <Badge
                                          variant={badgeVariantForCi(sessionSync.ci.state)}
                                          className="font-mono text-[10px] uppercase tracking-wide"
                                        >
                                          CI {sessionSync.ci.state} · {sessionSync.ci.summary}
                                        </Badge>
                                      ) : null}
                                      {sessionSync?.source === "error" ? (
                                        <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wide">
                                          PR sync unavailable
                                        </Badge>
                                      ) : null}
                                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                                        {session.workspaceType === "worktree" ? session.workspacePath : "project root"}
                                      </span>
                                    </div>
                                  </button>

                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 px-2 font-mono text-[10px]"
                                        disabled={updateSessionLifecycleMutation.isPending}
                                      >
                                        {SESSION_LIFECYCLE_LABELS[session.lifecycleState]}
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-48">
                                      <DropdownMenuLabel>Set Session State</DropdownMenuLabel>
                                      <DropdownMenuSeparator />
                                      {SESSION_LIFECYCLE_STATES.map((stateOption) => (
                                        <DropdownMenuItem
                                          key={stateOption}
                                          onSelect={() => {
                                            runAction(
                                              lifecycleActionId(stateOption),
                                              {
                                                source: "row",
                                                projectId: selectedProjectId ?? undefined,
                                                sessionId: session.id,
                                              },
                                              { suppressUnavailableToast: true },
                                            );
                                          }}
                                          disabled={updateSessionLifecycleMutation.isPending || session.lifecycleState === stateOption}
                                        >
                                          {SESSION_LIFECYCLE_LABELS[stateOption]}
                                        </DropdownMenuItem>
                                      ))}
                                    </DropdownMenuContent>
                                  </DropdownMenu>

                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button size="icon" variant="ghost" className="h-7 w-7">
                                        <MoreHorizontal className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-56">
                                      <DropdownMenuLabel>Session Actions</DropdownMenuLabel>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        onSelect={() => {
                                          addSessionToWorkspace(session.id);
                                        }}
                                      >
                                        Add to workspace
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onSelect={() => {
                                          if (isPinned) {
                                            unpinSessionFromWorkspaceBoard(session.projectId, session.id);
                                            return;
                                          }
                                          pinSessionToWorkspaceBoard(session.projectId, session.id);
                                        }}
                                      >
                                        {isPinned ? "Unpin from board" : "Pin to cross-project board"}
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        disabled={!canMoveUp}
                                        onSelect={() => {
                                          moveSession(session.id, -1);
                                        }}
                                      >
                                        Move up
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        disabled={!canMoveDown}
                                        onSelect={() => {
                                          moveSession(session.id, 1);
                                        }}
                                      >
                                        Move down
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        disabled={!canDeleteSession}
                                        onSelect={() => {
                                          runAction("session.delete.current", {
                                            source: "row",
                                            projectId: selectedProjectId ?? undefined,
                                            sessionId: session.id,
                                          });
                                        }}
                                      >
                                        Delete session
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : null}
                </section>

                <section className="rounded-md border border-border bg-card/60 p-2">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Cross-Project Board
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 font-mono text-[10px]"
                        disabled={!selectedSession}
                        onClick={() => {
                          if (!selectedSession) {
                            return;
                          }

                          if (isSessionPinned(selectedSession.projectId, selectedSession.id)) {
                            unpinSessionFromWorkspaceBoard(selectedSession.projectId, selectedSession.id);
                            return;
                          }

                          pinSessionToWorkspaceBoard(selectedSession.projectId, selectedSession.id);
                        }}
                      >
                        {selectedSession && isSessionPinned(selectedSession.projectId, selectedSession.id) ? "Unpin selected" : "Pin selected"}
                      </Button>
                    </div>

                    {workspaceBoardItems.length === 0 ? (
                      <p className="font-mono text-[11px] text-muted-foreground">No pinned sessions yet.</p>
                    ) : (
                      <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                        {workspaceBoardItems.map((entry) => {
                          const entryKey = workspaceBoardKey(entry);
                          const isActive =
                            selectedProjectId === entry.projectId && selectedSessionId === entry.sessionId;

                          return (
                            <div
                              key={entryKey}
                              className={`rounded-sm border px-2 py-1.5 ${
                                isActive ? "border-primary/60 bg-primary/10" : "border-border bg-card"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate font-mono text-xs font-semibold">{entry.sessionId}</p>
                                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                                    {entry.project?.name ?? entry.projectId}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 px-2 font-mono text-[10px]"
                                    onClick={() => {
                                      void openWorkspaceBoardEntry(entry).catch((error) => {
                                        toast.error(error instanceof Error ? error.message : String(error));
                                      });
                                    }}
                                  >
                                    Open
                                  </Button>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    onClick={() => {
                                      unpinSessionFromWorkspaceBoard(entry.projectId, entry.sessionId);
                                    }}
                                  >
                                    <PinOff className="h-4 w-4" />
                                  </Button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </section>

                {selectedSession ? (
                  <>
                    <Separator />

                    <div className="grid gap-2 font-mono text-xs text-muted-foreground">
                      <div className="flex justify-between">
                        <span>session state</span>
                        <span>
                          {SESSION_LIFECYCLE_LABELS[selectedSession.lifecycleState]} ·{" "}
                          {formatRelativeDuration(selectedSession.lifecycleUpdatedAt, nowMs)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>attached clients</span>
                        <span>{selectedSession.attachedClients}</span>
                      </div>
                    </div>
                  </>
                ) : null}

                <section className="rounded-md border border-border bg-card/60 p-2">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Workspace
                      </span>
                      {focusedWorkspaceItem?.session ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 font-mono text-[10px]"
                          onClick={() => {
                            setFocusedWorkspaceSlot(null);
                          }}
                        >
                          Exit focus
                        </Button>
                      ) : null}
                    </div>

                    <div className="grid grid-cols-3 gap-1">
                      <Button
                        size="sm"
                        variant={workspaceLayout === "single" ? "secondary" : "outline"}
                        className="h-7 px-2 font-mono text-[10px]"
                        onClick={() => {
                          setWorkspaceLayout("single");
                        }}
                      >
                        1-up
                      </Button>
                      <Button
                        size="sm"
                        variant={workspaceLayout === "split" ? "secondary" : "outline"}
                        className="h-7 px-2 font-mono text-[10px]"
                        onClick={() => {
                          setWorkspaceLayout("split");
                        }}
                      >
                        2-up
                      </Button>
                      <Button
                        size="sm"
                        variant={workspaceLayout === "quad" ? "secondary" : "outline"}
                        className="h-7 px-2 font-mono text-[10px]"
                        onClick={() => {
                          setWorkspaceLayout("quad");
                        }}
                      >
                        4-up
                      </Button>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 font-mono text-[10px]"
                        onClick={saveWorkspacePreset}
                        disabled={!selectedProjectId || orderedSessions.length === 0}
                      >
                        Save preset
                      </Button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 font-mono text-[10px]"
                            disabled={workspacePresets.length === 0}
                          >
                            Load preset
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-48">
                          <DropdownMenuLabel>Workspace Presets</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          {workspacePresets.map((preset) => (
                            <DropdownMenuItem
                              key={preset.name}
                              onSelect={() => {
                                loadWorkspacePreset(preset);
                              }}
                            >
                              {preset.name}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </section>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-border/80 bg-card/75 pr-1 font-mono"
                    onClick={() => {
                      openCommandPalette();
                    }}
                  >
                    <CommandIcon className="h-4 w-4" />
                    Commands
                    <span className="ml-1 rounded-sm border border-border/70 bg-card px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                      {commandHotkeyLabel}
                    </span>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </ResizablePanel>

          <ResizableHandle withHandle handleDirection={isStackedLayout ? "vertical" : "horizontal"} />

          <ResizablePanel defaultSize={isStackedLayout ? 64 : 72} minSize={isStackedLayout ? 40 : 35}>
            <Card className="h-full rounded-none border-0 bg-transparent shadow-none">
              <CardContent className="h-full rounded-none bg-[#1f1811] p-3">
                {selectedProjectId ? (
                  orderedSessions.length > 0 ? (
                    <div className={workspaceGridClass}>
                      {displayedWorkspaceItems.map(({ slotIndex, session }) => {
                        const slotSessionId = resolvedWorkspaceSlots[slotIndex] ?? "";
                        const slotSessionSync = session ? (sessionGitHubSyncById.get(session.id) ?? null) : null;
                        const isFocusedSlot = focusedWorkspaceSlot === slotIndex;
                        const isActiveSlot = Boolean(session) && slotIndex === activeVisibleSlotIndex;
                        const slotContainerClass = isFocusedSlot
                          ? "flex min-h-0 flex-col overflow-hidden rounded-md border-2 border-amber-300 bg-[#2b1a0b] shadow-[0_0_0_1px_rgba(252,211,77,0.55),0_16px_34px_rgba(0,0,0,0.42)]"
                          : isActiveSlot
                            ? "flex min-h-0 flex-col overflow-hidden rounded-md border border-amber-300/60 bg-[#23170f] shadow-[0_0_0_1px_rgba(252,211,77,0.22)]"
                            : "flex min-h-0 flex-col overflow-hidden rounded-md border border-border/40 bg-[#1a130f]";
                        const slotStatusClass = isFocusedSlot
                          ? "border-amber-200/90 bg-amber-300/25 text-amber-100"
                          : isActiveSlot
                            ? "border-amber-300/60 bg-amber-300/15 text-amber-100"
                            : "border-border/70 bg-card/65 text-muted-foreground";
                        const slotStatusLabel = isFocusedSlot ? "Focused" : isActiveSlot ? "Active" : "Live";
                        const slotStatusTooltip = isFocusedSlot
                          ? "Focused: this slot is in focus mode and is the only pane being shown."
                          : isActiveSlot
                            ? "Active: this is the terminal you most recently interacted with."
                            : "Live: this slot is running a session but is not currently active.";

                        return (
                          <div key={`workspace-slot-${slotIndex}`} className={slotContainerClass}>
                            <div
                              className={`h-0.5 w-full ${isFocusedSlot ? "bg-amber-300" : isActiveSlot ? "bg-amber-300/55" : "bg-transparent"}`}
                              aria-hidden
                            />
                            <div
                              className={`flex items-center justify-between gap-2 border-b border-border/40 p-2 ${
                                isFocusedSlot ? "bg-amber-200/10" : isActiveSlot ? "bg-amber-200/5" : "bg-card/40"
                              }`}
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <p
                                    className={`truncate font-mono text-[11px] font-semibold uppercase tracking-wide ${
                                      isFocusedSlot ? "text-amber-100" : isActiveSlot ? "text-amber-50" : "text-foreground/80"
                                    }`}
                                  >
                                    Slot {slotIndex + 1}
                                  </p>
                                  {session ? (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span
                                          className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${slotStatusClass}`}
                                        >
                                          {slotStatusLabel}
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent>{slotStatusTooltip}</TooltipContent>
                                    </Tooltip>
                                  ) : null}
                                </div>
                                <p className="truncate font-mono text-xs font-semibold text-foreground">
                                  {session ? session.id : "No session selected"}
                                </p>
                                {slotSessionSync?.pr || slotSessionSync?.ci ? (
                                  <div className="mt-1 flex flex-wrap items-center gap-1">
                                    {slotSessionSync.pr ? (
                                      <Badge
                                        variant={badgeVariantForPullRequest(
                                          slotSessionSync.pr.state,
                                          slotSessionSync.pr.isDraft,
                                        )}
                                        className="font-mono text-[10px] uppercase tracking-wide"
                                      >
                                        PR #{slotSessionSync.pr.number}
                                      </Badge>
                                    ) : null}
                                    {slotSessionSync.ci ? (
                                      <Badge
                                        variant={badgeVariantForCi(slotSessionSync.ci.state)}
                                        className="font-mono text-[10px] uppercase tracking-wide"
                                      >
                                        CI {slotSessionSync.ci.state}
                                      </Badge>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>

                              <div className="flex items-center gap-1">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <select
                                      value={slotSessionId}
                                      onChange={(event) => {
                                        const nextSessionId = event.target.value.trim() || null;
                                        setWorkspaceSlotSession(slotIndex, nextSessionId);
                                        if (nextSessionId) {
                                          setSelectedSessionId(nextSessionId);
                                        }
                                      }}
                                      className="h-7 min-w-[8rem] rounded-sm border border-border/70 bg-card px-2 font-mono text-[10px] text-foreground outline-none focus:border-primary/60"
                                    >
                                      <option value="">(empty)</option>
                                      {orderedSessions.map((workspaceSession) => (
                                        <option key={workspaceSession.id} value={workspaceSession.id}>
                                          {workspaceSession.id}
                                        </option>
                                      ))}
                                    </select>
                                  </TooltipTrigger>
                                  <TooltipContent>Assign session to this slot</TooltipContent>
                                </Tooltip>

                                {session ? (
                                  <>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className={`h-7 w-7 border border-border/70 ${
                                            focusedWorkspaceSlot === slotIndex
                                              ? "bg-primary/20 text-primary hover:bg-primary/25"
                                              : "bg-card/70 text-foreground hover:bg-card"
                                          }`}
                                          onClick={() => {
                                            setFocusedWorkspaceSlot((current) => (current === slotIndex ? null : slotIndex));
                                            setSelectedSessionId(session.id);
                                          }}
                                        >
                                          <Maximize2 className="h-4 w-4" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        {focusedWorkspaceSlot === slotIndex ? "Exit focus mode" : "Focus this slot"}
                                      </TooltipContent>
                                    </Tooltip>
                                  </>
                                ) : null}
                              </div>
                            </div>

                            <div className="min-h-0 flex-1">
                              {session ? (
                                <TerminalPane
                                  key={`${selectedProjectId}:${session.id}`}
                                  ref={(instance) => {
                                    terminalRefs.current[session.id] = instance;
                                  }}
                                  projectId={selectedProjectId}
                                  sessionId={session.id}
                                  onActivate={() => {
                                    setSelectedSessionId(session.id);
                                    setActiveWorkspaceSessionId(session.id);
                                  }}
                                  onConnectionStateChange={(state) => {
                                    setConnectionBySessionId((previous) => {
                                      if (previous[session.id] === state) {
                                        return previous;
                                      }
                                      return { ...previous, [session.id]: state };
                                    });
                                  }}
                                  onTerminalStateChange={(state) => {
                                    setTerminalStateBySessionId((previous) => {
                                      if (previous[session.id] === state) {
                                        return previous;
                                      }
                                      return { ...previous, [session.id]: state };
                                    });
                                  }}
                                  onSessionUnavailable={handleSessionUnavailable}
                                />
                              ) : (
                                <div className="flex h-full min-h-0 items-center justify-center text-center text-sm text-muted-foreground">
                                  <p>Pick a session for this slot.</p>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center rounded-none border border-border/30 bg-[#1f1811] text-center text-sm text-muted-foreground">
                      <div className="space-y-2">
                        <p>No sessions in this project yet.</p>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            runAction("session.new.auto", { source: "fallback" });
                          }}
                        >
                          <Plus className="h-4 w-4" />
                          Create session
                        </Button>
                      </div>
                    </div>
                  )
                ) : (
                  <div className="flex h-full items-center justify-center rounded-none border border-border/30 bg-[#1f1811] text-center text-sm text-muted-foreground">
                    <div className="space-y-2">
                      <p>No project selected.</p>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          runAction("project.new.pick", { source: "fallback" });
                        }}
                      >
                        <FolderOpen className="h-4 w-4" />
                        Pick project
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>

      <CommandDialog open={isCommandOpen} onOpenChange={handleCommandOpenChange}>
        <div className="border-b border-border/70 bg-muted/15 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-heading text-base text-foreground">Command Palette</p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {selectedProject ? selectedProject.name : "No project selected"}
              </p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                Acts on {actionTargetSession ? actionTargetSession.id : "no active slot session"}
              </p>
            </div>
            <span className="rounded-md border border-border/70 bg-card px-2 py-1 font-mono text-[10px] tracking-wide text-muted-foreground">
              {commandHotkeyLabel}
            </span>
          </div>
        </div>
        <CommandInput placeholder="Type a command..." />
        <CommandList>
          <CommandEmpty>No matching commands.</CommandEmpty>
          {actionsByGroup.map((entry) => (
            <CommandGroup key={entry.group} heading={entry.group}>
              {entry.actions.map((action) => {
                const availability = getActionAvailability(action.id, { source: "palette" });
                return (
                  <CommandItem
                    key={action.id}
                    className="group"
                    disabled={!availability.enabled}
                    onSelect={() => {
                      runAction(action.id, { source: "palette" });
                    }}
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-border/70 bg-card/60 text-muted-foreground transition-colors group-data-[selected=true]:border-primary/35 group-data-[selected=true]:bg-primary/12 group-data-[selected=true]:text-primary">
                      {renderActionIcon(action.icon)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{action.label}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {availability.enabled ? action.description : availability.disabledReason ?? action.description}
                      </span>
                    </span>
                    {action.paletteShortcut ? <CommandShortcut>{action.paletteShortcut}</CommandShortcut> : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
          <div className="px-3 pb-2 pt-2 font-mono text-[11px] text-muted-foreground">Press Esc to close.</div>
        </CommandList>
      </CommandDialog>

      <ConfirmDialog
        open={pendingActionConfirmation !== null}
        title={pendingActionConfirmation?.confirmation.title ?? ""}
        description={pendingActionConfirmation?.confirmation.description ?? ""}
        confirmLabel={pendingActionConfirmation?.confirmation.confirmLabel ?? "Confirm"}
        cancelLabel={pendingActionConfirmation?.confirmation.cancelLabel ?? "Cancel"}
        tone={pendingActionConfirmation?.confirmation.tone ?? "default"}
        pending={isConfirmationPending}
        onOpenChange={(open) => {
          if (!open) {
            if (pendingActionConfirmation?.invocation.source === "palette") {
              restoreCommandFocusTarget();
            }
            setPendingActionConfirmation(null);
          }
        }}
        onConfirm={handleConfirmPendingAction}
      />

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

              <div className="space-y-1.5">
                <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">Post-create hook command</p>
                <textarea
                  value={projectSettingsHookCommand}
                  onChange={(event) => {
                    setProjectSettingsHookCommand(event.currentTarget.value);
                  }}
                  placeholder="Optional. Runs in the new worktree after creation."
                  rows={4}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-primary/60"
                />
                <p className="font-mono text-[11px] text-muted-foreground">
                  Environment: BERM_PROJECT_ID, BERM_PROJECT_NAME, BERM_PROJECT_PATH, BERM_WORKTREE_BRANCH,
                  BERM_WORKTREE_PATH.
                </p>
              </div>

              <div className="space-y-1.5">
                <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">Hook timeout (ms)</p>
                <input
                  type="number"
                  value={projectSettingsHookTimeoutMs}
                  onChange={(event) => {
                    setProjectSettingsHookTimeoutMs(event.currentTarget.value);
                  }}
                  min={1000}
                  max={120000}
                  step={1000}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-primary/60"
                />
                <p className="font-mono text-[11px] text-muted-foreground">Allowed range: 1000 to 120000 ms.</p>
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

      {hookOutputDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <Card className="w-full max-w-2xl border-border/80 bg-card shadow-xl">
            <CardHeader className="space-y-1 pb-3">
              <CardTitle className="text-base">{hookOutputDialog.title}</CardTitle>
              <CardDescription className="font-mono text-xs">{hookOutputDialog.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">Command</p>
                <pre className="overflow-x-auto rounded-md border border-border bg-background p-2 font-mono text-xs">
                  {hookOutputDialog.hook.command}
                </pre>
              </div>

              {hookOutputDialog.hook.stdout.trim().length > 0 ? (
                <div className="space-y-1">
                  <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">stdout</p>
                  <pre className="max-h-52 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-xs">
                    {hookOutputDialog.hook.stdout}
                  </pre>
                </div>
              ) : null}

              {hookOutputDialog.hook.stderr.trim().length > 0 ? (
                <div className="space-y-1">
                  <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">stderr</p>
                  <pre className="max-h-52 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-xs">
                    {hookOutputDialog.hook.stderr}
                  </pre>
                </div>
              ) : null}

              <p className="font-mono text-[11px] text-muted-foreground">
                Exit code: {hookOutputDialog.hook.exitCode ?? "none"} · timed out:{" "}
                {hookOutputDialog.hook.timedOut ? "yes" : "no"} · succeeded:{" "}
                {hookOutputDialog.hook.succeeded ? "yes" : "no"}
              </p>

              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setHookOutputDialog(null);
                  }}
                >
                  Close
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {worktreeHookFailure ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <Card className="w-full max-w-2xl border-border/80 bg-card shadow-xl">
            <CardHeader className="space-y-1 pb-3">
              <CardTitle className="text-base">Worktree Hook Failed</CardTitle>
              <CardDescription className="font-mono text-xs">
                Branch {worktreeHookFailure.branchName} at {worktreeHookFailure.workspacePath}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">Command</p>
                <pre className="overflow-x-auto rounded-md border border-border bg-background p-2 font-mono text-xs">
                  {worktreeHookFailure.hook.command}
                </pre>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">stdout</p>
                  <pre className="max-h-44 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-xs">
                    {worktreeHookFailure.hook.stdout || "(empty)"}
                  </pre>
                </div>
                <div className="space-y-1">
                  <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">stderr</p>
                  <pre className="max-h-44 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-xs">
                    {worktreeHookFailure.hook.stderr || "(empty)"}
                  </pre>
                </div>
              </div>

              <p className="font-mono text-[11px] text-muted-foreground">
                Exit code: {worktreeHookFailure.hook.exitCode ?? "none"} · timed out:{" "}
                {worktreeHookFailure.hook.timedOut ? "yes" : "no"}
              </p>

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setWorktreeHookFailure(null);
                  }}
                  disabled={resolveWorktreeHookDecisionMutation.isPending}
                >
                  Dismiss
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    handleWorktreeHookDecision("abort");
                  }}
                  disabled={resolveWorktreeHookDecisionMutation.isPending}
                >
                  Abort and clean up
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    handleWorktreeHookDecision("continue");
                  }}
                  disabled={resolveWorktreeHookDecisionMutation.isPending}
                >
                  Continue anyway
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </TooltipProvider>
  );
}
