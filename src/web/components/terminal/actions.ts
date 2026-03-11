import {
  SESSION_LIFECYCLE_LABELS,
  SESSION_LIFECYCLE_STATES,
  type SessionLifecycleState,
} from "../../../shared/session-lifecycle";

type SessionLifecycleActionId = `session.lifecycle.${SessionLifecycleState}`;

export type TerminalActionId =
  | "project.new.pick"
  | "project.delete.current"
  | "session.new.auto"
  | "session.new.custom"
  | "session.import.worktrees"
  | "session.delete.current"
  | "session.reconnect"
  | SessionLifecycleActionId
  | "view.toggle-sidebar"
  | "view.toggle-wide-mode"
  | "view.toggle-activity-indicators"
  | "view.hide-header"
  | "view.show-header";

export type TerminalActionGroup = "Project" | "Session" | "View";
export type TerminalActionIcon =
  | "folder"
  | "plus"
  | "trash"
  | "refresh"
  | "flag"
  | "search"
  | "hammer"
  | "review"
  | "pr"
  | "merged"
  | "blocked"
  | "paused"
  | "panel-left"
  | "expand"
  | "eye-open"
  | "eye-closed";
export type TerminalActionSource = "palette" | "button" | "dropdown" | "row" | "fallback";

export interface TerminalActionInvocation {
  source: TerminalActionSource;
  projectId?: string;
  sessionId?: string;
}

export interface TerminalActionAvailability {
  enabled: boolean;
  disabledReason?: string;
}

export interface TerminalActionConfirmation {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "destructive";
}

export interface TerminalActionContext {
  selectedProjectId: string | null;
  selectedProjectName: string | null;
  selectedSessionId: string | null;
  selectedSessionName: string | null;
  selectedSessionLifecycleState: SessionLifecycleState | null;
  isSidebarVisible: boolean;
  isWideMode: boolean;
  isHeaderVisible: boolean;
  isActivityIndicatorsVisible: boolean;
  pending: {
    pickProject: boolean;
    createSession: boolean;
    importWorktrees: boolean;
    deleteSession: boolean;
    deleteProject: boolean;
    updateSessionLifecycle: boolean;
  };
}

export interface TerminalActionHandlers {
  pickProject: () => void | Promise<void>;
  createSessionAuto: () => void;
  createSessionCustom: () => void;
  importWorktrees: () => void;
  deleteProject: (projectId: string) => void;
  deleteSession: (request: { projectId: string; sessionId: string }) => void;
  reconnectSession: () => void;
  setSessionLifecycleState: (request: {
    projectId: string;
    sessionId: string;
    lifecycleState: SessionLifecycleState;
  }) => void;
  toggleSidebar: () => void;
  toggleWideMode: () => void;
  toggleActivityIndicators: () => void;
  hideHeader: () => void;
  showHeader: () => void;
}

export interface TerminalActionDefinition {
  id: TerminalActionId;
  label: string;
  description: string;
  group: TerminalActionGroup;
  icon: TerminalActionIcon;
  keywords: string[];
  paletteShortcut?: string;
  getAvailability: (context: TerminalActionContext, invocation: TerminalActionInvocation) => TerminalActionAvailability;
  getConfirmation?: (
    context: TerminalActionContext,
    invocation: TerminalActionInvocation,
  ) => TerminalActionConfirmation | null;
  run: (context: TerminalActionContext, handlers: TerminalActionHandlers, invocation: TerminalActionInvocation) => void;
}

function resolveProjectId(context: TerminalActionContext, invocation: TerminalActionInvocation): string | null {
  return invocation.projectId ?? context.selectedProjectId ?? null;
}

function resolveSessionId(context: TerminalActionContext, invocation: TerminalActionInvocation): string | null {
  return invocation.sessionId ?? context.selectedSessionId ?? null;
}

function lifecycleActionId(state: SessionLifecycleState): SessionLifecycleActionId {
  return `session.lifecycle.${state}`;
}

function lifecycleActionIcon(state: SessionLifecycleState): TerminalActionIcon {
  switch (state) {
    case "planning":
      return "flag";
    case "exploration":
      return "search";
    case "implementing":
      return "hammer";
    case "in_review":
      return "review";
    case "submitted_pr":
      return "pr";
    case "merged":
      return "merged";
    case "blocked":
      return "blocked";
    case "paused":
      return "paused";
    default: {
      const neverState: never = state;
      throw new Error(`Unknown lifecycle state '${neverState as string}'`);
    }
  }
}

const SESSION_LIFECYCLE_ACTIONS: TerminalActionDefinition[] = SESSION_LIFECYCLE_STATES.map((state) => ({
  id: lifecycleActionId(state),
  label: `Set State: ${SESSION_LIFECYCLE_LABELS[state]}`,
  description: `Mark selected session as ${SESSION_LIFECYCLE_LABELS[state].toLowerCase()}.`,
  group: "Session",
  icon: lifecycleActionIcon(state),
  keywords: ["session", "state", "lifecycle", state, SESSION_LIFECYCLE_LABELS[state].toLowerCase()],
  getAvailability: (context, invocation) => {
    const projectId = resolveProjectId(context, invocation);
    if (!projectId) {
      return { enabled: false, disabledReason: "Select a project first" };
    }

    if (!resolveSessionId(context, invocation)) {
      return { enabled: false, disabledReason: "Select a session first" };
    }

    if (context.pending.updateSessionLifecycle) {
      return { enabled: false, disabledReason: "Session state update in progress" };
    }

    if (
      !invocation.sessionId &&
      !invocation.projectId &&
      context.selectedSessionLifecycleState === state
    ) {
      return { enabled: false, disabledReason: `Already ${SESSION_LIFECYCLE_LABELS[state].toLowerCase()}` };
    }

    return { enabled: true };
  },
  run: (context, handlers, invocation) => {
    const projectId = resolveProjectId(context, invocation);
    const sessionId = resolveSessionId(context, invocation);
    if (!projectId || !sessionId) {
      return;
    }

    handlers.setSessionLifecycleState({ projectId, sessionId, lifecycleState: state });
  },
}));

export const TERMINAL_ACTIONS: TerminalActionDefinition[] = [
  {
    id: "session.new.auto",
    label: "New Session (Auto)",
    description: "Create a new main session with auto-generated name.",
    group: "Session",
    icon: "plus",
    keywords: ["session", "new", "create", "auto"],
    getAvailability: (context) => {
      if (!context.selectedProjectId) {
        return { enabled: false, disabledReason: "Select a project first" };
      }
      if (context.pending.createSession) {
        return { enabled: false, disabledReason: "Session creation in progress" };
      }
      return { enabled: true };
    },
    run: (_context, handlers) => {
      handlers.createSessionAuto();
    },
  },
  {
    id: "session.new.custom",
    label: "New Session (Custom)",
    description: "Create a new main session and optionally set its name.",
    group: "Session",
    icon: "plus",
    keywords: ["session", "new", "create", "custom", "name"],
    getAvailability: (context) => {
      if (!context.selectedProjectId) {
        return { enabled: false, disabledReason: "Select a project first" };
      }
      if (context.pending.createSession) {
        return { enabled: false, disabledReason: "Session creation in progress" };
      }
      return { enabled: true };
    },
    run: (_context, handlers) => {
      handlers.createSessionCustom();
    },
  },
  {
    id: "session.import.worktrees",
    label: "Import Existing Worktrees",
    description: "Create sessions from existing linked git worktrees in the selected project.",
    group: "Session",
    icon: "refresh",
    keywords: ["session", "worktree", "import", "git", "discover", "sync"],
    getAvailability: (context) => {
      if (!context.selectedProjectId) {
        return { enabled: false, disabledReason: "Select a project first" };
      }
      if (context.pending.importWorktrees) {
        return { enabled: false, disabledReason: "Worktree import already in progress" };
      }
      return { enabled: true };
    },
    run: (_context, handlers) => {
      handlers.importWorktrees();
    },
  },
  {
    id: "session.delete.current",
    label: "Delete Session",
    description: "Delete the selected session.",
    group: "Session",
    icon: "trash",
    keywords: ["session", "delete", "remove"],
    getAvailability: (context, invocation) => {
      const projectId = resolveProjectId(context, invocation);
      if (!projectId) {
        return { enabled: false, disabledReason: "Select a project first" };
      }
      if (!resolveSessionId(context, invocation)) {
        return { enabled: false, disabledReason: "Select a session first" };
      }
      if (context.pending.deleteSession) {
        return { enabled: false, disabledReason: "Session deletion already in progress" };
      }
      return { enabled: true };
    },
    getConfirmation: (context, invocation) => {
      const sessionId = resolveSessionId(context, invocation);
      if (!sessionId) {
        return null;
      }
      return {
        title: "Delete session?",
        description: `Delete session '${sessionId}'? This will kill the tmux session.`,
        confirmLabel: "Delete session",
        tone: "destructive",
      };
    },
    run: (context, handlers, invocation) => {
      const projectId = resolveProjectId(context, invocation);
      const sessionId = resolveSessionId(context, invocation);
      if (!projectId || !sessionId) {
        return;
      }
      handlers.deleteSession({ projectId, sessionId });
    },
  },
  {
    id: "session.reconnect",
    label: "Reconnect",
    description: "Reconnect WebSocket to selected session.",
    group: "Session",
    icon: "refresh",
    keywords: ["session", "reconnect", "socket", "websocket"],
    getAvailability: (context, invocation) => {
      if (!resolveSessionId(context, invocation)) {
        return { enabled: false, disabledReason: "Select a session first" };
      }
      return { enabled: true };
    },
    run: (_context, handlers) => {
      handlers.reconnectSession();
    },
  },
  ...SESSION_LIFECYCLE_ACTIONS,
  {
    id: "project.new.pick",
    label: "New Project",
    description: "Pick a directory and select it as a project.",
    group: "Project",
    icon: "folder",
    keywords: ["project", "new", "pick", "directory", "folder"],
    getAvailability: (context) => {
      if (context.pending.pickProject) {
        return { enabled: false, disabledReason: "Project picker is already open" };
      }
      return { enabled: true };
    },
    run: (_context, handlers) => {
      void handlers.pickProject();
    },
  },
  {
    id: "project.delete.current",
    label: "Delete Project",
    description: "Delete selected project and all project sessions.",
    group: "Project",
    icon: "trash",
    keywords: ["project", "delete", "remove"],
    getAvailability: (context, invocation) => {
      if (!resolveProjectId(context, invocation)) {
        return { enabled: false, disabledReason: "Select a project first" };
      }
      if (context.pending.deleteProject) {
        return { enabled: false, disabledReason: "Project deletion already in progress" };
      }
      return { enabled: true };
    },
    getConfirmation: (context, invocation) => {
      const projectId = resolveProjectId(context, invocation);
      if (!projectId) {
        return null;
      }
      const projectName = context.selectedProjectName ?? projectId;
      return {
        title: "Delete project?",
        description: `Delete project '${projectName}' and all of its sessions? This will kill all tmux sessions in that project.`,
        confirmLabel: "Delete project",
        tone: "destructive",
      };
    },
    run: (context, handlers, invocation) => {
      const projectId = resolveProjectId(context, invocation);
      if (!projectId) {
        return;
      }
      handlers.deleteProject(projectId);
    },
  },
  {
    id: "view.toggle-sidebar",
    label: "Toggle Sidebar",
    description: "Show or hide the left control sidebar.",
    group: "View",
    icon: "panel-left",
    keywords: ["view", "sidebar", "left pane", "toggle", "hide", "show"],
    paletteShortcut: "⌘⇧B / Ctrl+Shift+B",
    getAvailability: () => {
      return { enabled: true };
    },
    run: (_context, handlers) => {
      handlers.toggleSidebar();
    },
  },
  {
    id: "view.toggle-wide-mode",
    label: "Toggle Wide Mode",
    description: "Toggle full-width layout with minimal side padding.",
    group: "View",
    icon: "expand",
    keywords: ["view", "layout", "wide", "full width", "padding"],
    getAvailability: () => {
      return { enabled: true };
    },
    run: (_context, handlers) => {
      handlers.toggleWideMode();
    },
  },
  {
    id: "view.toggle-activity-indicators",
    label: "Toggle Activity Indicators",
    description: "Show or hide the session refresh and GitHub sync activity indicators.",
    group: "View",
    icon: "refresh",
    keywords: ["view", "activity", "indicators", "github", "sync", "polling", "status", "toggle", "show", "hide"],
    getAvailability: () => {
      return { enabled: true };
    },
    run: (_context, handlers) => {
      handlers.toggleActivityIndicators();
    },
  },
  {
    id: "view.hide-header",
    label: "Hide Header",
    description: "Hide the top site header.",
    group: "View",
    icon: "eye-closed",
    keywords: ["header", "hide", "view", "chrome"],
    getAvailability: (context) => {
      if (!context.isHeaderVisible) {
        return { enabled: false, disabledReason: "Header is already hidden" };
      }
      return { enabled: true };
    },
    run: (_context, handlers) => {
      handlers.hideHeader();
    },
  },
  {
    id: "view.show-header",
    label: "Show Header",
    description: "Show the top site header.",
    group: "View",
    icon: "eye-open",
    keywords: ["header", "show", "view", "chrome"],
    getAvailability: (context) => {
      if (context.isHeaderVisible) {
        return { enabled: false, disabledReason: "Header is already visible" };
      }
      return { enabled: true };
    },
    run: (_context, handlers) => {
      handlers.showHeader();
    },
  },
];
