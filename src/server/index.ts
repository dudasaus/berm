import { join, basename, dirname, isAbsolute } from "path";
import { readdirSync, realpathSync, statSync } from "fs";
import { RpcSession, type RpcTransport } from "capnweb";
import app from "../web/index.html";
import { version, commitHash } from "../build-info";

/**
 * When running from a pre-built bundle (bun build --target=bun), the HTML
 * import becomes a manifest with relative file paths. Bun.serve() resolves
 * those paths relative to CWD, which breaks when the CLI is run from a
 * different directory (e.g. via bunx). This helper detects the pre-built
 * case and creates explicit routes using absolute paths derived from
 * import.meta.dir (the directory containing the bundled cli.js).
 */
function resolveAppRoutes(): Record<string, any> {
  if (!app.files) {
    // Dev mode — Bun.serve() handles bundling at runtime
    return { "/": app };
  }

  // Pre-built: resolve each file relative to the bundle's directory
  const baseDir = import.meta.dir;
  const routes: Record<string, any> = {};

  for (const file of app.files) {
    const absPath = join(baseDir, file.path);
    if (file.loader === "html") {
      routes["/"] = Bun.file(absPath);
    } else {
      const urlPath = "/" + file.path.replace(/^\.\//, "");
      routes[urlPath] = Bun.file(absPath);
    }
  }

  // Serve additional static assets (e.g. favicon) not listed in the manifest
  const manifestPaths = new Set(app.files.map((f) => basename(f.path)));
  const assetExts = new Set([".png", ".ico", ".svg", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2"]);
  for (const entry of readdirSync(baseDir)) {
    const ext = entry.slice(entry.lastIndexOf("."));
    if (assetExts.has(ext) && !manifestPaths.has(entry)) {
      routes["/" + entry] = Bun.file(join(baseDir, entry));
    }
  }

  return routes;
}
import { serializeMessage, type ServerMessage } from "../shared/protocol";
import { parseNotificationRequest } from "../shared/notifications";
import {
  type CreateSessionResult,
  type CreateSessionRequest,
  type ImportWorktreeSessionsRequest,
  type ListImportWorktreeCandidatesResult,
  type ImportWorktreeSessionsResult,
  type ProjectMetadata,
  type ResolveWorktreeHookDecisionRequest,
  type ResolveWorktreeHookDecisionResult,
  type SendSessionInputRequest,
  type SessionMetadata,
  TerminalSessionManager,
  type UpdateProjectRequest,
  type UpdateSessionLifecycleRequest,
  isSessionManagerError,
  type SessionClient,
} from "./terminal-session";
import { NotificationService } from "./notifications";

type TerminalWebSocketData = {
  kind: "terminal";
  projectId: string;
  sessionId: string;
  clientId: string;
};

type NotificationWebSocketData = {
  kind: "notifications";
  rpcSession?: RpcSession;
  rpcTransport?: BunServerWebSocketRpcTransport;
};

type WebSocketData = TerminalWebSocketData | NotificationWebSocketData;

class BunServerWebSocketRpcTransport implements RpcTransport {
  #closedError: Error | null = null;
  #queuedMessages: string[] = [];
  #receivers: Array<{ resolve: (message: string) => void; reject: (error: Error) => void }> = [];

  constructor(private readonly ws: Bun.ServerWebSocket<WebSocketData>) {}

  async send(message: string): Promise<void> {
    this.ws.send(message);
  }

  receive(): Promise<string> {
    const queued = this.#queuedMessages.shift();
    if (typeof queued === "string") {
      return Promise.resolve(queued);
    }

    if (this.#closedError) {
      return Promise.reject(this.#closedError);
    }

    return new Promise((resolve, reject) => {
      this.#receivers.push({ resolve, reject });
    });
  }

  dispatchMessage(message: string | Buffer<ArrayBuffer>) {
    const data = typeof message === "string" ? message : textDecoder.decode(message);
    const receiver = this.#receivers.shift();
    if (receiver) {
      receiver.resolve(data);
      return;
    }

    this.#queuedMessages.push(data);
  }

  dispatchClose(code: number, reason: string) {
    this.#closedError = new Error(`WebSocket closed: ${code}${reason ? ` ${reason}` : ""}`);
    const receivers = this.#receivers.splice(0);
    for (const receiver of receivers) {
      receiver.reject(this.#closedError);
    }
  }

  dispatchError(error: Error) {
    this.#closedError = error;
    const receivers = this.#receivers.splice(0);
    for (const receiver of receivers) {
      receiver.reject(error);
    }
  }

  abort(reason: unknown) {
    const message = reason instanceof Error ? reason.message : String(reason);
    this.ws.close(1011, message.slice(0, 120));
  }
}

type GitHubPullRequestState = "OPEN" | "CLOSED" | "MERGED";

type GitHubSessionPrInfo = {
  number: number;
  title: string;
  url: string;
  state: GitHubPullRequestState;
  isDraft: boolean;
};

type GitHubSessionCiState = "success" | "failure" | "pending" | "none";

type GitHubSessionCiInfo = {
  state: GitHubSessionCiState;
  summary: string;
  total: number;
  passing: number;
  failing: number;
  pending: number;
};

type GitHubSessionSyncItem = {
  sessionId: string;
  branchName: string | null;
  pr: GitHubSessionPrInfo | null;
  ci: GitHubSessionCiInfo | null;
  source: "github" | "none" | "error";
  error?: string;
};

type GitHubSyncPayload = {
  sessions: GitHubSessionSyncItem[];
  syncedAt: string;
};

type GitHubSyncResponse = GitHubSyncPayload & {
  cached: boolean;
  refreshing: boolean;
};

const GITHUB_SYNC_CACHE_TTL_MS = 15_000;
const GITHUB_SYNC_FAILURE_RETRY_MS = 5_000;
const EMPTY_GITHUB_SYNC_AT = new Date(0).toISOString();
const githubSyncCache = new Map<
  string,
  {
    expiresAtMs: number;
    hasValue: boolean;
    payload: GitHubSyncPayload;
    refreshPromise: Promise<void> | null;
  }
>();
const textDecoder = new TextDecoder();

type SpawnSyncResultLike = {
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
  exitCode: number;
};

type SpawnSyncLike = (
  cmd: string[],
  options?: {
    stdout?: "pipe";
    stderr?: "pipe";
  },
) => SpawnSyncResultLike;

type EnvLike = Record<string, string | undefined>;

export interface SessionManagerLike {
  listProjects(): ProjectMetadata[];
  selectProject(path: string): ProjectMetadata;
  updateProject(projectId: string, input: UpdateProjectRequest): ProjectMetadata;
  deleteProject(projectId: string): boolean;
  getProject(projectId: string): ProjectMetadata | null;
  listSessions(projectId: string): SessionMetadata[];
  listAllSessions(): SessionMetadata[];
  listImportWorktreeCandidates(projectId: string): ListImportWorktreeCandidatesResult;
  importWorktreeSessions(projectId: string, request?: ImportWorktreeSessionsRequest): ImportWorktreeSessionsResult;
  createSession(projectId: string, request?: CreateSessionRequest): CreateSessionResult;
  resolveWorktreeHookDecision(projectId: string, request: ResolveWorktreeHookDecisionRequest): ResolveWorktreeHookDecisionResult;
  updateSessionLifecycleState(projectId: string, sessionId: string, input: UpdateSessionLifecycleRequest): SessionMetadata;
  sendSessionInput(projectId: string, sessionId: string, input: SendSessionInputRequest): SessionMetadata;
  deleteSession(projectId: string, sessionId: string): boolean;
  hasSession(projectId: string, sessionId: string): boolean;
  attachClient(projectId: string, sessionId: string, client: SessionClient): SessionMetadata | null;
  handleClientMessage(projectId: string, sessionId: string, clientId: string, rawMessage: unknown): void;
  detachClient(projectId: string, sessionId: string, clientId: string): void;
  getSessionMetadata(projectId: string, sessionId: string): SessionMetadata | null;
  shutdown(): Promise<void>;
}

interface CreateServerOptions {
  manager?: SessionManagerLike;
  notifications?: NotificationService;
  pickProjectDirectory?: () => Response;
  defaultProjectPath?: string;
  host?: string;
  port?: number;
}

export interface ServerConfig {
  routes: Record<string, unknown>;
  websocket: {
    data: WebSocketData;
    open: (ws: Bun.ServerWebSocket<WebSocketData>) => void;
    message: (ws: Bun.ServerWebSocket<WebSocketData>, message: string | Buffer<ArrayBuffer>) => void;
    close: (ws: Bun.ServerWebSocket<WebSocketData>, code?: number, reason?: string) => void;
  };
}

function createDefaultManager(): TerminalSessionManager {
  return new TerminalSessionManager({
    tmuxSocketName: envWithLegacy("BERM_TMUX_SOCKET", "COMMAND_CENTER_TMUX_SOCKET"),
    registryPath: envWithLegacy("BERM_REGISTRY_PATH", "COMMAND_CENTER_REGISTRY_PATH"),
  });
}

function envWithLegacy(currentName: string, legacyName: string): string | undefined {
  return Bun.env[currentName] ?? Bun.env[legacyName] ?? undefined;
}

export function buildHealthResponse(): Response {
  return Response.json({
    ok: true,
    now: new Date().toISOString(),
  });
}

export function buildVersionResponse(): Response {
  return Response.json({ version, commitHash });
}

export function buildSessionResponse(
  sessionManager: SessionManagerLike,
  projectId: string,
  sessionId: string,
): Response {
  const metadata = sessionManager.getSessionMetadata(projectId, sessionId);
  if (!metadata) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  return Response.json(metadata);
}

function errorResponse(error: unknown): Response {
  if (isSessionManagerError(error)) {
    return Response.json(
      {
        error: error.message,
        code: error.code,
        ...(error.details ?? {}),
      },
      { status: error.statusCode },
    );
  }

  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

function decodeSpawnOutput(output: string | Uint8Array | undefined): string {
  if (typeof output === "string") {
    return output;
  }
  if (!output) {
    return "";
  }

  return textDecoder.decode(output);
}

function failedToLaunchPicker(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json(
    { error: message || "Unable to open native project picker", code: "PROJECT_PICK_FAILED" },
    { status: 500 },
  );
}

function mapPickerProcessResult(result: SpawnSyncResultLike, cancelMatcher: (stderr: string) => boolean): Response {
  const stdout = decodeSpawnOutput(result.stdout).trim();
  const stderr = decodeSpawnOutput(result.stderr).trim();

  if (result.exitCode !== 0) {
    if (cancelMatcher(stderr)) {
      return Response.json({ error: "Project picker cancelled", code: "PROJECT_PICK_CANCELLED" }, { status: 400 });
    }

    return Response.json(
      { error: stderr || "Unable to open native project picker", code: "PROJECT_PICK_FAILED" },
      { status: 500 },
    );
  }

  if (!stdout) {
    return Response.json({ error: "No project path returned from picker", code: "PROJECT_PICK_EMPTY" }, { status: 500 });
  }

  return Response.json({ path: stdout });
}

function pickProjectDirectoryMacOS(spawnSync: SpawnSyncLike): Response {
  try {
    const result = spawnSync(
      ["osascript", "-e", 'POSIX path of (choose folder with prompt "Select Berm Project")'],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    return mapPickerProcessResult(result, (stderr) => stderr.toLowerCase().includes("user canceled"));
  } catch (error) {
    return failedToLaunchPicker(error);
  }
}

function runWindowsPicker(spawnSync: SpawnSyncLike, executables: string[]): SpawnSyncResultLike | Response {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    '$dialog.Description = "Select Berm Project"',
    "$dialog.UseDescriptionForTitle = $true",
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath); exit 0 }',
    '[Console]::Error.Write("PROJECT_PICK_CANCELLED")',
    "exit 2",
  ].join("; ");

  for (const executable of executables) {
    try {
      return spawnSync([executable, "-NoProfile", "-STA", "-Command", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      if (executable === executables.at(-1)) {
        return failedToLaunchPicker(error);
      }
    }
  }

  return Response.json(
    { error: "Unable to open native project picker", code: "PROJECT_PICK_FAILED" },
    { status: 500 },
  );
}

function isResponse(value: SpawnSyncResultLike | Response): value is Response {
  return value instanceof Response;
}

function pickProjectDirectoryWindows(spawnSync: SpawnSyncLike): Response {
  const result = runWindowsPicker(spawnSync, ["powershell", "pwsh"]);
  if (isResponse(result)) {
    return result;
  }

  return mapPickerProcessResult(result, (stderr) => stderr.includes("PROJECT_PICK_CANCELLED"));
}

function isWsl(env: EnvLike): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

function pickProjectDirectoryWsl(spawnSync: SpawnSyncLike): Response {
  const pickerResult = runWindowsPicker(spawnSync, ["powershell.exe", "pwsh.exe"]);
  if (isResponse(pickerResult)) {
    return pickerResult;
  }

  const stdout = decodeSpawnOutput(pickerResult.stdout).trim();
  if (pickerResult.exitCode !== 0) {
    return mapPickerProcessResult(pickerResult, (value) => value.includes("PROJECT_PICK_CANCELLED"));
  }

  if (!stdout) {
    return Response.json({ error: "No project path returned from picker", code: "PROJECT_PICK_EMPTY" }, { status: 500 });
  }

  try {
    const translated = spawnSync(["wslpath", "-a", stdout], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const translatedStdout = decodeSpawnOutput(translated.stdout).trim();
    const translatedStderr = decodeSpawnOutput(translated.stderr).trim();

    if (translated.exitCode !== 0) {
      return Response.json(
        { error: translatedStderr || "Unable to translate Windows path for WSL", code: "PROJECT_PICK_FAILED" },
        { status: 500 },
      );
    }

    if (!translatedStdout) {
      return Response.json({ error: "No project path returned from picker", code: "PROJECT_PICK_EMPTY" }, { status: 500 });
    }

    return Response.json({ path: translatedStdout });
  } catch (error) {
    return failedToLaunchPicker(error);
  }
}

export function pickProjectDirectoryForPlatform(
  platform: NodeJS.Platform,
  spawnSync: SpawnSyncLike = Bun.spawnSync,
  env: EnvLike = process.env,
): Response {
  if (platform === "darwin") {
    return pickProjectDirectoryMacOS(spawnSync);
  }

  if (platform === "win32") {
    return pickProjectDirectoryWindows(spawnSync);
  }

  if (platform === "linux" && isWsl(env)) {
    return pickProjectDirectoryWsl(spawnSync);
  }

  return Response.json(
    { error: "Native directory picker is currently supported on macOS, Windows, and WSL only", code: "PROJECT_PICK_UNSUPPORTED" },
    { status: 501 },
  );
}

function pickProjectDirectory(): Response {
  return pickProjectDirectoryForPlatform(process.platform, Bun.spawnSync, process.env);
}

async function runCommand(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    ]);

    return {
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function runCommandSync(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const result = Bun.spawnSync(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      exitCode: result.exitCode,
      stdout: textDecoder.decode(result.stdout).trim(),
      stderr: textDecoder.decode(result.stderr).trim(),
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveSessionBranchName(session: SessionMetadata): string | null {
  if (session.branchName && session.branchName.trim().length > 0) {
    return session.branchName.trim();
  }

  const branchResult = runCommandSync(["git", "-C", session.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"], session.workspacePath);
  if (branchResult.exitCode !== 0 || !branchResult.stdout || branchResult.stdout === "HEAD") {
    return null;
  }

  return branchResult.stdout;
}

async function resolveSessionBranchNameAsync(session: SessionMetadata): Promise<string | null> {
  if (session.branchName && session.branchName.trim().length > 0) {
    return session.branchName.trim();
  }

  const branchResult = await runCommand(
    ["git", "-C", session.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"],
    session.workspacePath,
  );
  if (branchResult.exitCode !== 0 || !branchResult.stdout || branchResult.stdout === "HEAD") {
    return null;
  }

  return branchResult.stdout;
}

function summarizeStatusChecks(statusCheckRollup: unknown): GitHubSessionCiInfo | null {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return null;
  }

  let passing = 0;
  let failing = 0;
  let pending = 0;

  for (const check of statusCheckRollup) {
    if (!check || typeof check !== "object") {
      pending += 1;
      continue;
    }

    const record = check as { status?: unknown; conclusion?: unknown };
    const status = typeof record.status === "string" ? record.status.toUpperCase() : "";
    const conclusion = typeof record.conclusion === "string" ? record.conclusion.toUpperCase() : "";

    if (status && status !== "COMPLETED") {
      pending += 1;
      continue;
    }

    if (!conclusion) {
      pending += 1;
      continue;
    }

    if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
      passing += 1;
      continue;
    }

    failing += 1;
  }

  const total = statusCheckRollup.length;
  const summaryParts: string[] = [];
  if (passing > 0) {
    summaryParts.push(`${passing} passing`);
  }
  if (failing > 0) {
    summaryParts.push(`${failing} failing`);
  }
  if (pending > 0) {
    summaryParts.push(`${pending} pending`);
  }

  return {
    state: failing > 0 ? "failure" : pending > 0 ? "pending" : passing > 0 ? "success" : "none",
    summary: summaryParts.length > 0 ? summaryParts.join(", ") : "No checks",
    total,
    passing,
    failing,
    pending,
  };
}

function buildGitHubSyncForSession(session: SessionMetadata): GitHubSessionSyncItem {
  const branchName = resolveSessionBranchName(session);
  if (!branchName) {
    return {
      sessionId: session.id,
      branchName: null,
      pr: null,
      ci: null,
      source: "none",
    };
  }

  const ghResult = runCommandSync(
    [
      "gh",
      "pr",
      "list",
      "--head",
      branchName,
      "--state",
      "all",
      "--json",
      "number,title,url,state,isDraft,statusCheckRollup",
      "--limit",
      "1",
    ],
    session.workspacePath,
  );

  if (ghResult.exitCode !== 0) {
    return {
      sessionId: session.id,
      branchName,
      pr: null,
      ci: null,
      source: "error",
      error: ghResult.stderr || "Unable to sync PR/CI status from GitHub",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(ghResult.stdout);
  } catch {
    return {
      sessionId: session.id,
      branchName,
      pr: null,
      ci: null,
      source: "error",
      error: "GitHub CLI returned invalid JSON",
    };
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed[0] || typeof parsed[0] !== "object") {
    return {
      sessionId: session.id,
      branchName,
      pr: null,
      ci: null,
      source: "none",
    };
  }

  const item = parsed[0] as {
    number?: unknown;
    title?: unknown;
    url?: unknown;
    state?: unknown;
    isDraft?: unknown;
    statusCheckRollup?: unknown;
  };

  const state = typeof item.state === "string" ? item.state.toUpperCase() : "";
  const prState: GitHubPullRequestState =
    state === "OPEN" || state === "CLOSED" || state === "MERGED" ? state : "OPEN";

  return {
    sessionId: session.id,
    branchName,
    pr: {
      number: typeof item.number === "number" ? item.number : 0,
      title: typeof item.title === "string" ? item.title : "",
      url: typeof item.url === "string" ? item.url : "",
      state: prState,
      isDraft: item.isDraft === true,
    },
    ci: summarizeStatusChecks(item.statusCheckRollup),
    source: "github",
  };
}

async function buildGitHubSyncForSessionAsync(session: SessionMetadata): Promise<GitHubSessionSyncItem> {
  const branchName = await resolveSessionBranchNameAsync(session);
  if (!branchName) {
    return {
      sessionId: session.id,
      branchName: null,
      pr: null,
      ci: null,
      source: "none",
    };
  }

  const ghResult = await runCommand(
    [
      "gh",
      "pr",
      "list",
      "--head",
      branchName,
      "--state",
      "all",
      "--json",
      "number,title,url,state,isDraft,statusCheckRollup",
      "--limit",
      "1",
    ],
    session.workspacePath,
  );

  if (ghResult.exitCode !== 0) {
    return {
      sessionId: session.id,
      branchName,
      pr: null,
      ci: null,
      source: "error",
      error: ghResult.stderr || "Unable to sync PR/CI status from GitHub",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(ghResult.stdout);
  } catch {
    return {
      sessionId: session.id,
      branchName,
      pr: null,
      ci: null,
      source: "error",
      error: "GitHub CLI returned invalid JSON",
    };
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed[0] || typeof parsed[0] !== "object") {
    return {
      sessionId: session.id,
      branchName,
      pr: null,
      ci: null,
      source: "none",
    };
  }

  const item = parsed[0] as {
    number?: unknown;
    title?: unknown;
    url?: unknown;
    state?: unknown;
    isDraft?: unknown;
    statusCheckRollup?: unknown;
  };

  const state = typeof item.state === "string" ? item.state.toUpperCase() : "";
  const prState: GitHubPullRequestState =
    state === "OPEN" || state === "CLOSED" || state === "MERGED" ? state : "OPEN";

  return {
    sessionId: session.id,
    branchName,
    pr: {
      number: typeof item.number === "number" ? item.number : 0,
      title: typeof item.title === "string" ? item.title : "",
      url: typeof item.url === "string" ? item.url : "",
      state: prState,
      isDraft: item.isDraft === true,
    },
    ci: summarizeStatusChecks(item.statusCheckRollup),
    source: "github",
  };
}

function getGitHubSyncCacheEntry(projectId: string) {
  const existing = githubSyncCache.get(projectId);
  if (existing) {
    return existing;
  }

  const created = {
    expiresAtMs: 0,
    hasValue: false,
    payload: {
      sessions: [],
      syncedAt: EMPTY_GITHUB_SYNC_AT,
    },
    refreshPromise: null as Promise<void> | null,
  };
  githubSyncCache.set(projectId, created);
  return created;
}

async function refreshGitHubSyncCache(manager: SessionManagerLike, projectId: string): Promise<void> {
  const entry = getGitHubSyncCacheEntry(projectId);
  if (entry.refreshPromise) {
    return entry.refreshPromise;
  }

  const refreshPromise = (async () => {
    try {
      const sessions = manager.listSessions(projectId);
      const items: GitHubSessionSyncItem[] = [];
      for (const session of sessions) {
        items.push(await buildGitHubSyncForSessionAsync(session));
      }

      const activeEntry = githubSyncCache.get(projectId);
      if (!activeEntry) {
        return;
      }

      activeEntry.hasValue = true;
      activeEntry.expiresAtMs = Date.now() + GITHUB_SYNC_CACHE_TTL_MS;
      activeEntry.payload = {
        sessions: items,
        syncedAt: new Date().toISOString(),
      };
    } catch {
      const activeEntry = githubSyncCache.get(projectId);
      if (!activeEntry) {
        return;
      }

      activeEntry.expiresAtMs = Date.now() + GITHUB_SYNC_FAILURE_RETRY_MS;
    }
  })().finally(() => {
    const activeEntry = githubSyncCache.get(projectId);
    if (activeEntry?.refreshPromise === refreshPromise) {
      activeEntry.refreshPromise = null;
    }
  });

  entry.refreshPromise = refreshPromise;
  return refreshPromise;
}

function buildGitHubSyncResponse(manager: SessionManagerLike, projectId: string): GitHubSyncResponse {
  const nowMs = Date.now();
  const entry = getGitHubSyncCacheEntry(projectId);
  const isFresh = entry.hasValue && entry.expiresAtMs > nowMs;

  if (!isFresh && !entry.refreshPromise) {
    void refreshGitHubSyncCache(manager, projectId);
  }

  return {
    ...entry.payload,
    cached: entry.hasValue,
    refreshing: entry.refreshPromise !== null,
  };
}

type ProjectPickerSuggestion = {
  path: string;
  name: string;
  score: number;
};

const MAX_PROJECT_PICKER_SCAN_ENTRIES = 2_000;
const MAX_PROJECT_PICKER_SUGGESTIONS = 20;

function normalizeDefaultProjectPath(defaultProjectPath: string): string {
  try {
    return realpathSync(defaultProjectPath);
  } catch {
    return defaultProjectPath;
  }
}

function isPathSeparator(value: string): boolean {
  return value === "/" || value === "\\";
}

function directorySubsequenceScore(candidate: string, query: string): number | null {
  let score = 0;
  let queryIndex = 0;
  let lastMatchIndex = -1;

  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) {
      continue;
    }

    score += lastMatchIndex >= 0 ? index - lastMatchIndex : index;
    lastMatchIndex = index;
    queryIndex += 1;

    if (queryIndex === query.length) {
      return score;
    }
  }

  return null;
}

function scoreProjectDirectorySuggestion(candidatePath: string, candidateName: string, rawQuery: string): number | null {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return 900;
  }

  const normalizedCandidateName = candidateName.toLowerCase();

  if (candidatePath.toLowerCase() === query) {
    return 0;
  }

  if (normalizedCandidateName === query) {
    return 10;
  }

  if (normalizedCandidateName.startsWith(query)) {
    return 20 + normalizedCandidateName.length - query.length;
  }

  const basenameIndex = normalizedCandidateName.indexOf(query);
  if (basenameIndex >= 0) {
    return 40 + basenameIndex;
  }

  const basenameFuzzy = directorySubsequenceScore(normalizedCandidateName, query);
  if (basenameFuzzy !== null) {
    return 120 + basenameFuzzy;
  }

  return null;
}

function buildProjectPickerSuggestions(inputQuery: string): {
  query: string;
  basePath: string | null;
  suggestions: ProjectPickerSuggestion[];
} {
  const query = inputQuery.trim();
  if (!query || !isAbsolute(query)) {
    return { query, basePath: null, suggestions: [] };
  }

  const treatAsDirectoryBrowse = isPathSeparator(query.at(-1) ?? "");
  const searchRoot = treatAsDirectoryBrowse ? query : dirname(query);
  const searchTerm = treatAsDirectoryBrowse ? "" : basename(query);

  let normalizedBasePath: string;
  try {
    normalizedBasePath = realpathSync(searchRoot);
  } catch {
    return { query, basePath: searchRoot, suggestions: [] };
  }

  let entries: Array<{ name: string }>;
  try {
    entries = readdirSync(normalizedBasePath, { withFileTypes: true }).slice(0, MAX_PROJECT_PICKER_SCAN_ENTRIES);
  } catch {
    return { query, basePath: normalizedBasePath, suggestions: [] };
  }

  const suggestions: ProjectPickerSuggestion[] = [];
  for (const entry of entries) {
    const entryPath = join(normalizedBasePath, entry.name);

    let normalizedEntryPath = entryPath;
    try {
      normalizedEntryPath = realpathSync(entryPath);
      if (!statSync(normalizedEntryPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const score = scoreProjectDirectorySuggestion(normalizedEntryPath, basename(normalizedEntryPath), searchTerm || query);
    if (searchTerm && score === null) {
      continue;
    }

    suggestions.push({
      path: normalizedEntryPath,
      name: basename(normalizedEntryPath),
      score: score ?? 900,
    });
  }

  suggestions.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

  return {
    query,
    basePath: normalizedBasePath,
    suggestions: suggestions.slice(0, MAX_PROJECT_PICKER_SUGGESTIONS),
  };
}

function prefixRoutes(prefix: string, routes: Record<string, unknown>): Record<string, unknown> {
  const prefixed: Record<string, unknown> = {};
  for (const [path, handler] of Object.entries(routes)) {
    prefixed[`${prefix}${path}`] = handler;
  }
  return prefixed;
}

export function createServerConfig(
  manager: SessionManagerLike,
  openProjectPicker: () => Response = pickProjectDirectory,
  defaultProjectPath = process.cwd(),
  notifications = new NotificationService(),
): ServerConfig {
  const normalizedDefaultProjectPath = normalizeDefaultProjectPath(defaultProjectPath);
  const apiRoutes: Record<string, unknown> = {
    "/health": () => buildHealthResponse(),
    "/version": () => buildVersionResponse(),
    "/notifications": {
      GET: () => {
        return Response.json({ notifications: notifications.listRecent() });
      },
      POST: async (req: Request) => {
        const body = (await req.json().catch(() => ({}))) as unknown;
        const parsed = parseNotificationRequest(body, "api");
        if (!parsed.ok) {
          return Response.json({ error: parsed.error, code: parsed.code }, { status: 400 });
        }

        return Response.json(notifications.publish(parsed.value), { status: 201 });
      },
    },
    "/projects": {
      GET: () => {
        return Response.json({ projects: manager.listProjects() });
      },
    },
    "/projects/select": {
      POST: async (req: Request) => {
        try {
          const body = (await req.json().catch(() => ({}))) as { path?: string };
          const path = typeof body.path === "string" ? body.path : "";
          const project = manager.selectProject(path);
          return Response.json(project, { status: 201 });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    "/projects/picker": {
      GET: () => {
        return Response.json({ defaultPath: normalizedDefaultProjectPath });
      },
    },
    "/projects/picker/suggest": {
      GET: (req: Request) => {
        const url = new URL(req.url);
        const query = url.searchParams.get("q") ?? "";
        return Response.json(buildProjectPickerSuggestions(query));
      },
    },
    "/projects/:id": {
      PATCH: async (req: Bun.BunRequest<"/projects/:id">) => {
        try {
          const body = (await req.json().catch(() => ({}))) as UpdateProjectRequest;
          const project = manager.updateProject(req.params.id, body);
          return Response.json(project);
        } catch (error) {
          return errorResponse(error);
        }
      },
      DELETE: (req: Bun.BunRequest<"/projects/:id">) => {
        try {
          const deleted = manager.deleteProject(req.params.id);
          if (!deleted) {
            return Response.json({ error: "Project not found" }, { status: 404 });
          }

          return Response.json({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    "/projects/pick": {
      POST: () => {
        return openProjectPicker();
      },
    },
    "/sessions": {
      GET: () => {
        return Response.json({ sessions: manager.listAllSessions() });
      },
    },
    "/projects/:projectId/sessions": {
      GET: (req: Bun.BunRequest<"/projects/:projectId/sessions">) => {
        const project = manager.getProject(req.params.projectId);
        if (!project) {
          return Response.json({ error: "Project not found" }, { status: 404 });
        }

        return Response.json({ sessions: manager.listSessions(req.params.projectId) });
      },
      POST: async (req: Bun.BunRequest<"/projects/:projectId/sessions">) => {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            mode?: unknown;
            name?: unknown;
            branchName?: unknown;
          };

          let request: CreateSessionRequest | undefined;
          if (body.mode === "worktree") {
            request = {
              mode: "worktree",
              branchName: typeof body.branchName === "string" ? body.branchName : "",
            };
          } else if (typeof body.mode === "undefined" || body.mode === "main") {
            request = {
              mode: "main",
              name: typeof body.name === "string" ? body.name : undefined,
            };
          } else {
            request = body as CreateSessionRequest;
          }

          const created = manager.createSession(req.params.projectId, request);
          return Response.json(created, { status: 201 });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    "/projects/:projectId/sessions/import-worktrees": {
      GET: (req: Bun.BunRequest<"/projects/:projectId/sessions/import-worktrees">) => {
        try {
          return Response.json(manager.listImportWorktreeCandidates(req.params.projectId));
        } catch (error) {
          return errorResponse(error);
        }
      },
      POST: async (req: Bun.BunRequest<"/projects/:projectId/sessions/import-worktrees">) => {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            workspacePaths?: unknown;
          };

          const request: ImportWorktreeSessionsRequest = {
            workspacePaths: Array.isArray(body.workspacePaths)
              ? body.workspacePaths.filter((value): value is string => typeof value === "string")
              : undefined,
          };
          return Response.json(manager.importWorktreeSessions(req.params.projectId, request));
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    "/projects/:projectId/sessions/github-sync": {
      GET: (req: Bun.BunRequest<"/projects/:projectId/sessions/github-sync">) => {
        const project = manager.getProject(req.params.projectId);
        if (!project) {
          return Response.json({ error: "Project not found" }, { status: 404 });
        }

        return Response.json(buildGitHubSyncResponse(manager, req.params.projectId));
      },
    },
    "/projects/:projectId/sessions/worktree-hook-decision": {
      POST: async (req: Bun.BunRequest<"/projects/:projectId/sessions/worktree-hook-decision">) => {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            decisionToken?: unknown;
            decision?: unknown;
          };

          const result = manager.resolveWorktreeHookDecision(req.params.projectId, {
            decisionToken: typeof body.decisionToken === "string" ? body.decisionToken : "",
            decision: body.decision as ResolveWorktreeHookDecisionRequest["decision"],
          });

          if (result.action === "continue") {
            return Response.json(result, { status: 201 });
          }

          return Response.json(result);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    "/projects/:projectId/sessions/:id/input": {
      POST: async (req: Bun.BunRequest<"/projects/:projectId/sessions/:id/input">) => {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            data?: unknown;
            force?: unknown;
          };
          if (typeof body.data !== "string" || body.data.length === 0) {
            return Response.json(
              { error: "data must be a non-empty string", code: "SESSION_INPUT_INVALID" },
              { status: 400 },
            );
          }

          const session = manager.sendSessionInput(req.params.projectId, req.params.id, {
            data: body.data,
            force: body.force === true,
          });
          return Response.json({ ok: true, session });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    "/projects/:projectId/sessions/:id": {
      GET: (req: Bun.BunRequest<"/projects/:projectId/sessions/:id">) =>
        buildSessionResponse(manager, req.params.projectId, req.params.id),
      PATCH: async (req: Bun.BunRequest<"/projects/:projectId/sessions/:id">) => {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            lifecycleState?: unknown;
          };
          const session = manager.updateSessionLifecycleState(req.params.projectId, req.params.id, {
            lifecycleState: body.lifecycleState as UpdateSessionLifecycleRequest["lifecycleState"],
          });
          return Response.json(session);
        } catch (error) {
          return errorResponse(error);
        }
      },
      DELETE: (req: Bun.BunRequest<"/projects/:projectId/sessions/:id">) => {
        try {
          const deleted = manager.deleteSession(req.params.projectId, req.params.id);
          if (!deleted) {
            return Response.json({ error: "Session not found" }, { status: 404 });
          }

          return Response.json({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  };

  const terminalRoute = (req: Request, serverRef: Pick<Bun.Server<WebSocketData>, "upgrade">) => {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("projectId")?.trim();
    if (!projectId) {
      return Response.json({ error: "projectId query parameter is required" }, { status: 400 });
    }

    const sessionId = url.searchParams.get("sessionId")?.trim();
    if (!sessionId) {
      return Response.json({ error: "sessionId query parameter is required" }, { status: 400 });
    }

    if (!manager.hasSession(projectId, sessionId)) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const upgraded = serverRef.upgrade(req, {
      data: {
        kind: "terminal",
        projectId,
        sessionId,
        clientId: crypto.randomUUID(),
      },
    });

    if (!upgraded) {
      return Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
    }

    return undefined;
  };

  const notificationRoute = (req: Request, serverRef: Pick<Bun.Server<WebSocketData>, "upgrade">) => {
    const upgraded = serverRef.upgrade(req, {
      data: {
        kind: "notifications",
      },
    });

    if (!upgraded) {
      return Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
    }

    return undefined;
  };

  return {
    routes: {
      ...resolveAppRoutes(),
      ...prefixRoutes("/api", apiRoutes),
      ...prefixRoutes("/api/v1", apiRoutes),
      "/ws/terminal": terminalRoute,
      "/api/v1/ws/terminal": terminalRoute,
      "/ws/notifications": notificationRoute,
      "/api/v1/ws/notifications": notificationRoute,
    },
    websocket: {
      data: { kind: "terminal", projectId: "", sessionId: "", clientId: "" } as WebSocketData,
      open(ws: Bun.ServerWebSocket<WebSocketData>) {
        if (ws.data.kind === "notifications") {
          const transport = new BunServerWebSocketRpcTransport(ws);
          ws.data.rpcTransport = transport;
          ws.data.rpcSession = new RpcSession(transport, notifications.createApi());
          return;
        }

        const client: SessionClient = {
          id: ws.data.clientId,
          send(message: ServerMessage) {
            ws.send(serializeMessage(message));
          },
          close(code, reason) {
            ws.close(code, reason);
          },
        };

        const attached = manager.attachClient(ws.data.projectId, ws.data.sessionId, client);
        if (!attached) {
          ws.send(serializeMessage({ type: "session_not_found", sessionId: ws.data.sessionId }));
          ws.close(4004, "Session not found");
        }
      },
      message(ws: Bun.ServerWebSocket<WebSocketData>, message: string | Buffer<ArrayBuffer>) {
        if (ws.data.kind === "notifications") {
          ws.data.rpcTransport?.dispatchMessage(message);
          return;
        }

        manager.handleClientMessage(ws.data.projectId, ws.data.sessionId, ws.data.clientId, message);
      },
      close(ws: Bun.ServerWebSocket<WebSocketData>, code = 1000, reason = "") {
        if (ws.data.kind === "notifications") {
          ws.data.rpcTransport?.dispatchClose(code, reason);
          return;
        }

        manager.detachClient(ws.data.projectId, ws.data.sessionId, ws.data.clientId);
      },
    },
  };
}

export function createServer(options: number | CreateServerOptions = {}) {
  const normalized: CreateServerOptions = typeof options === "number" ? { port: options } : options;
  const host = normalized.host ?? envWithLegacy("BERM_HOST", "COMMAND_CENTER_HOST") ?? "127.0.0.1";
  const port = normalized.port ?? Number(envWithLegacy("BERM_PORT", "COMMAND_CENTER_PORT") ?? 3000);
  const manager = normalized.manager ?? createDefaultManager();
  const notifications = normalized.notifications ?? new NotificationService();
  const openProjectPicker = normalized.pickProjectDirectory ?? pickProjectDirectory;
  const config = createServerConfig(manager, openProjectPicker, normalized.defaultProjectPath ?? process.cwd(), notifications);

  const serverOptions = {
    hostname: host,
    port,
    routes: config.routes,
    websocket: {
      data: config.websocket.data,
      open(ws) {
        config.websocket.open(ws);
      },
      message(ws, message) {
        config.websocket.message(ws, message);
      },
      close(ws, code, reason) {
        config.websocket.close(ws, code, reason);
      },
    },
  } as Bun.Serve.Options<WebSocketData, string>;

  const server = Bun.serve<WebSocketData, string>(serverOptions);

  return {
    server,
    manager,
    async stop(force = false) {
      await manager.shutdown();
      await server.stop(force);
    },
  };
}

if (import.meta.main) {
  const { server } = createServer();
  console.log(`Berm listening at ${server.url}`);
}
