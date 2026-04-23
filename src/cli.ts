import { createServer } from "./server/index";

const DEFAULT_HOST = Bun.env.BERM_HOST ?? Bun.env.COMMAND_CENTER_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(Bun.env.BERM_PORT ?? Bun.env.COMMAND_CENTER_PORT ?? 3000);
const SESSION_LIFECYCLE_STATES = [
  "planning",
  "exploration",
  "implementing",
  "in_review",
  "submitted_pr",
  "merged",
  "blocked",
  "paused",
] as const;

type SessionLifecycleState = (typeof SESSION_LIFECYCLE_STATES)[number];

interface SharedCliOptions {
  help: boolean;
  host: string;
  json: boolean;
  port?: number;
}

type ServeCommand = SharedCliOptions & {
  kind: "serve";
};

type DaemonStatusCommand = SharedCliOptions & {
  kind: "daemon-status";
};

type ProjectsListCommand = SharedCliOptions & {
  kind: "projects-list";
};

type ProjectsSelectCommand = SharedCliOptions & {
  kind: "projects-select";
  path?: string;
};

type SessionsListCommand = SharedCliOptions & {
  kind: "sessions-list";
  projectId?: string;
};

type SessionsCreateCommand = SharedCliOptions & {
  kind: "sessions-create";
  branchName?: string;
  name?: string;
  projectId?: string;
  worktree: boolean;
};

type SessionsGetCommand = SharedCliOptions & {
  kind: "sessions-get";
  projectId?: string;
  sessionId?: string;
};

type SessionsDeleteCommand = SharedCliOptions & {
  kind: "sessions-delete";
  projectId?: string;
  sessionId?: string;
};

type SessionsLifecycleSetCommand = SharedCliOptions & {
  kind: "sessions-lifecycle-set";
  lifecycleState?: SessionLifecycleState;
  projectId?: string;
  sessionId?: string;
};

export type CliCommand =
  | ServeCommand
  | DaemonStatusCommand
  | ProjectsListCommand
  | ProjectsSelectCommand
  | SessionsListCommand
  | SessionsCreateCommand
  | SessionsGetCommand
  | SessionsDeleteCommand
  | SessionsLifecycleSetCommand;

interface ProjectMetadata {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastUsedAt: string;
  worktreeEnabled: boolean;
  worktreeParentPath: string | null;
  worktreeHookCommand: string | null;
  worktreeHookTimeoutMs: number;
}

interface SessionMetadata {
  id: string;
  projectId: string;
  state: string;
  connected: boolean;
  cols: number;
  rows: number;
  pid: number | null;
  createdAt: string;
  lastActiveAt: string;
  attachedClients: number;
  workspaceType: string;
  workspacePath: string;
  branchName: string | null;
  lifecycleState: SessionLifecycleState;
  lifecycleUpdatedAt: string;
}

interface SessionHookResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  succeeded: boolean;
}

interface CreateSessionResult {
  session: SessionMetadata;
  hook: SessionHookResult | null;
}

function usage(): string {
  return [
    "Usage:",
    "  berm help",
    "  berm [--host <hostname>] [--port <number>]",
    "  berm daemon start [--host <hostname>] [--port <number>]",
    "  berm daemon status [--host <hostname>] [--port <number>] [--json]",
    "  berm projects list [--host <hostname>] [--port <number>] [--json]",
    "  berm projects select <path> [--host <hostname>] [--port <number>] [--json]",
    "  berm sessions list --project <id> [--host <hostname>] [--port <number>] [--json]",
    "  berm sessions create --project <id> [--name <name>] [--json]",
    "  berm sessions create --project <id> --worktree --branch <branch> [--json]",
    "  berm sessions get --project <id> --session <id> [--json]",
    "  berm sessions delete --project <id> --session <id> [--json]",
    "  berm sessions lifecycle set --project <id> --session <id> --state <state> [--json]",
    "",
    "Global options:",
    "  -H, --host <hostname>  Hostname for the Berm server/client (default: 127.0.0.1)",
    "  -p, --port <number>    Port for the Berm server/client (default: 3000)",
    "      --json             Print command results as JSON",
    "  -h, --help             Show this help text",
    "",
    `Lifecycle states: ${SESSION_LIFECYCLE_STATES.join(", ")}`,
  ].join("\n");
}

function parsePort(raw: string, arg: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port for ${arg}: ${raw}`);
  }
  return port;
}

function defaultOptions(): SharedCliOptions {
  return {
    help: false,
    host: DEFAULT_HOST,
    json: false,
    port: undefined,
  };
}

function cloneOptions(options: SharedCliOptions): SharedCliOptions {
  return { ...options };
}

function consumeSharedOption(argv: string[], index: number, options: SharedCliOptions): number | null {
  const arg = argv[index];
  if (arg === "-h" || arg === "--help") {
    options.help = true;
    return index + 1;
  }

  if (arg === "--json") {
    options.json = true;
    return index + 1;
  }

  if (arg === "-H" || arg === "--host") {
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${arg}`);
    }
    options.host = value;
    return index + 2;
  }

  if (arg === "-p" || arg === "--port") {
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${arg}`);
    }
    options.port = parsePort(value, arg);
    return index + 2;
  }

  return null;
}

function assertNoExtraArgs(argv: string[], index: number): void {
  if (index < argv.length) {
    throw new Error(`Unknown argument: ${argv[index]}`);
  }
}

function requireOptionValue(arg: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing value for ${arg}`);
  }
  return value;
}

function parseProjectsCommand(argv: string[], index: number, baseOptions: SharedCliOptions): CliCommand {
  const subcommand = argv[index];
  if (!subcommand) {
    throw new Error("Missing projects subcommand");
  }

  if (subcommand === "help") {
    return { kind: "serve", ...cloneOptions(baseOptions), help: true };
  }

  if (subcommand === "list") {
    const options = cloneOptions(baseOptions);
    index += 1;
    while (index < argv.length) {
      const nextIndex = consumeSharedOption(argv, index, options);
      if (nextIndex === null) {
        throw new Error(`Unknown argument: ${argv[index]}`);
      }
      index = nextIndex;
    }

    return { kind: "projects-list", ...options };
  }

  if (subcommand === "select") {
    const options = cloneOptions(baseOptions);
    let path: string | undefined;
    index += 1;

    while (index < argv.length) {
      const nextIndex = consumeSharedOption(argv, index, options);
      if (nextIndex !== null) {
        index = nextIndex;
        continue;
      }

      if (!path) {
        path = argv[index];
        index += 1;
        continue;
      }

      throw new Error(`Unknown argument: ${argv[index]}`);
    }

    return { kind: "projects-select", path, ...options };
  }

  throw new Error(`Unknown projects subcommand: ${subcommand}`);
}

function parseSessionsCommand(argv: string[], index: number, baseOptions: SharedCliOptions): CliCommand {
  const subcommand = argv[index];
  if (!subcommand) {
    throw new Error("Missing sessions subcommand");
  }

  if (subcommand === "help") {
    return { kind: "serve", ...cloneOptions(baseOptions), help: true };
  }

  if (subcommand === "list") {
    const options = cloneOptions(baseOptions);
    let projectId: string | undefined;
    index += 1;

    while (index < argv.length) {
      const nextIndex = consumeSharedOption(argv, index, options);
      if (nextIndex !== null) {
        index = nextIndex;
        continue;
      }

      const arg = argv[index];
      if (arg === "--project") {
        projectId = requireOptionValue(arg, argv[index + 1]);
        index += 2;
        continue;
      }

      throw new Error(`Unknown argument: ${arg}`);
    }

    return { kind: "sessions-list", projectId, ...options };
  }

  if (subcommand === "create") {
    const options = cloneOptions(baseOptions);
    let branchName: string | undefined;
    let name: string | undefined;
    let projectId: string | undefined;
    let worktree = false;
    index += 1;

    while (index < argv.length) {
      const nextIndex = consumeSharedOption(argv, index, options);
      if (nextIndex !== null) {
        index = nextIndex;
        continue;
      }

      const arg = argv[index];
      if (arg === "--project") {
        projectId = requireOptionValue(arg, argv[index + 1]);
        index += 2;
        continue;
      }

      if (arg === "--name") {
        name = requireOptionValue(arg, argv[index + 1]);
        index += 2;
        continue;
      }

      if (arg === "--branch") {
        branchName = requireOptionValue(arg, argv[index + 1]);
        index += 2;
        continue;
      }

      if (arg === "--worktree") {
        worktree = true;
        index += 1;
        continue;
      }

      throw new Error(`Unknown argument: ${arg}`);
    }

    return { kind: "sessions-create", branchName, name, projectId, worktree, ...options };
  }

  if (subcommand === "get" || subcommand === "delete") {
    const options = cloneOptions(baseOptions);
    let projectId: string | undefined;
    let sessionId: string | undefined;
    index += 1;

    while (index < argv.length) {
      const nextIndex = consumeSharedOption(argv, index, options);
      if (nextIndex !== null) {
        index = nextIndex;
        continue;
      }

      const arg = argv[index];
      if (arg === "--project") {
        projectId = requireOptionValue(arg, argv[index + 1]);
        index += 2;
        continue;
      }

      if (arg === "--session") {
        sessionId = requireOptionValue(arg, argv[index + 1]);
        index += 2;
        continue;
      }

      throw new Error(`Unknown argument: ${arg}`);
    }

    if (subcommand === "get") {
      return { kind: "sessions-get", projectId, sessionId, ...options };
    }

    return { kind: "sessions-delete", projectId, sessionId, ...options };
  }

  if (subcommand === "lifecycle") {
    if (argv[index + 1] === "help") {
      return { kind: "serve", ...cloneOptions(baseOptions), help: true };
    }

    if (argv[index + 1] !== "set") {
      throw new Error("Unknown sessions lifecycle subcommand");
    }

    const options = cloneOptions(baseOptions);
    let lifecycleState: SessionLifecycleState | undefined;
    let projectId: string | undefined;
    let sessionId: string | undefined;
    index += 2;

    while (index < argv.length) {
      const nextIndex = consumeSharedOption(argv, index, options);
      if (nextIndex !== null) {
        index = nextIndex;
        continue;
      }

      const arg = argv[index];
      if (arg === "--project") {
        projectId = requireOptionValue(arg, argv[index + 1]);
        index += 2;
        continue;
      }

      if (arg === "--session") {
        sessionId = requireOptionValue(arg, argv[index + 1]);
        index += 2;
        continue;
      }

      if (arg === "--state") {
        const rawState = requireOptionValue(arg, argv[index + 1]);
        if (!SESSION_LIFECYCLE_STATES.includes(rawState as SessionLifecycleState)) {
          throw new Error(`Invalid lifecycle state: ${rawState}`);
        }
        lifecycleState = rawState as SessionLifecycleState;
        index += 2;
        continue;
      }

      throw new Error(`Unknown argument: ${arg}`);
    }

    return { kind: "sessions-lifecycle-set", lifecycleState, projectId, sessionId, ...options };
  }

  throw new Error(`Unknown sessions subcommand: ${subcommand}`);
}

export function parseCliArgs(argv: string[]): CliCommand {
  const globalOptions = defaultOptions();
  let index = 0;

  while (index < argv.length) {
    const nextIndex = consumeSharedOption(argv, index, globalOptions);
    if (nextIndex === null) {
      break;
    }
    index = nextIndex;
  }

  if (index >= argv.length) {
    return { kind: "serve", ...globalOptions };
  }

  const command = argv[index];
  index += 1;

  if (command === "help") {
    return { kind: "serve", ...cloneOptions(globalOptions), help: true };
  }

  if (command === "daemon") {
    const subcommand = argv[index];
    if (subcommand === "help") {
      return { kind: "serve", ...cloneOptions(globalOptions), help: true };
    }

    if (!subcommand || subcommand === "start") {
      const options = cloneOptions(globalOptions);
      if (subcommand === "start") {
        index += 1;
      }

      while (index < argv.length) {
        const nextIndex = consumeSharedOption(argv, index, options);
        if (nextIndex === null) {
          throw new Error(`Unknown argument: ${argv[index]}`);
        }
        index = nextIndex;
      }

      return { kind: "serve", ...options };
    }

    if (subcommand === "status") {
      const options = cloneOptions(globalOptions);
      index += 1;

      while (index < argv.length) {
        const nextIndex = consumeSharedOption(argv, index, options);
        if (nextIndex === null) {
          throw new Error(`Unknown argument: ${argv[index]}`);
        }
        index = nextIndex;
      }

      return { kind: "daemon-status", ...options };
    }

    throw new Error(`Unknown daemon subcommand: ${subcommand}`);
  }

  if (command === "projects") {
    return parseProjectsCommand(argv, index, globalOptions);
  }

  if (command === "sessions") {
    return parseSessionsCommand(argv, index, globalOptions);
  }

  throw new Error(`Unknown command: ${command}`);
}

function resolvedPort(port: number | undefined): number {
  if (!Number.isInteger(DEFAULT_PORT) || DEFAULT_PORT < 1 || DEFAULT_PORT > 65535) {
    return port ?? 3000;
  }
  return port ?? DEFAULT_PORT;
}

function baseUrl(command: SharedCliOptions): string {
  return `http://${command.host}:${resolvedPort(command.port)}`;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printProject(project: ProjectMetadata): void {
  console.log(`${project.id}\t${project.name}\t${project.path}`);
}

function printSession(session: SessionMetadata): void {
  console.log(
    `${session.id}\t${session.projectId}\t${session.workspaceType}\t${session.lifecycleState}\t${session.workspacePath}`,
  );
}

function printSessionDetails(session: SessionMetadata): void {
  console.log(`id: ${session.id}`);
  console.log(`projectId: ${session.projectId}`);
  console.log(`workspaceType: ${session.workspaceType}`);
  console.log(`workspacePath: ${session.workspacePath}`);
  console.log(`lifecycleState: ${session.lifecycleState}`);
  console.log(`state: ${session.state}`);
  console.log(`connected: ${session.connected}`);
  console.log(`attachedClients: ${session.attachedClients}`);
  console.log(`createdAt: ${session.createdAt}`);
  console.log(`lastActiveAt: ${session.lastActiveAt}`);
}

async function fetchJson<T>(command: SharedCliOptions, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(command)}/api/v1${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to reach Berm at ${baseUrl(command)}: ${message}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload =
    contentType.includes("application/json") ? ((await response.json()) as unknown) : await response.text();

  if (!response.ok) {
    if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
      throw new Error(payload.error);
    }
    throw new Error(`Request failed with status ${response.status}`);
  }

  return payload as T;
}

function requireProjectId(projectId: string | undefined, help: boolean): string {
  if (projectId || help) {
    return projectId ?? "";
  }
  throw new Error("Missing required option: --project");
}

function requireSessionId(sessionId: string | undefined, help: boolean): string {
  if (sessionId || help) {
    return sessionId ?? "";
  }
  throw new Error("Missing required option: --session");
}

function requireLifecycleState(state: SessionLifecycleState | undefined, help: boolean): SessionLifecycleState {
  if (state || help) {
    return state ?? "planning";
  }
  throw new Error("Missing required option: --state");
}

function requireProjectPath(path: string | undefined, help: boolean): string {
  if (path || help) {
    return path ?? "";
  }
  throw new Error("Missing project path");
}

async function handleClientCommand(command: CliCommand): Promise<number> {
  switch (command.kind) {
    case "daemon-status": {
      try {
        const [health, version] = await Promise.all([
          fetchJson<{ ok: boolean; now: string }>(command, "/health"),
          fetchJson<{ version: string; commitHash?: string }>(command, "/version"),
        ]);
        const payload = {
          ok: health.ok,
          now: health.now,
          version: version.version,
          commitHash: version.commitHash ?? null,
          host: command.host,
          port: resolvedPort(command.port),
        };
        if (command.json) {
          printJson(payload);
        } else {
          console.log(
            `Berm is running at ${baseUrl(command)} (version ${payload.version}${payload.commitHash ? `, ${payload.commitHash}` : ""})`,
          );
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (command.json) {
          printJson({
            ok: false,
            error: message,
            host: command.host,
            port: resolvedPort(command.port),
          });
        } else {
          console.error(message);
        }
        return 1;
      }
    }

    case "projects-list": {
      const payload = await fetchJson<{ projects: ProjectMetadata[] }>(command, "/projects");
      if (command.json) {
        printJson(payload);
      } else if (payload.projects.length === 0) {
        console.log("No projects.");
      } else {
        for (const project of payload.projects) {
          printProject(project);
        }
      }
      return 0;
    }

    case "projects-select": {
      const path = requireProjectPath(command.path, command.help);
      const project = await fetchJson<ProjectMetadata>(command, "/projects/select", {
        method: "POST",
        body: JSON.stringify({ path }),
      });
      if (command.json) {
        printJson(project);
      } else {
        console.log(`Selected project ${project.name} (${project.id})`);
      }
      return 0;
    }

    case "sessions-list": {
      const projectId = requireProjectId(command.projectId, command.help);
      const payload = await fetchJson<{ sessions: SessionMetadata[] }>(command, `/projects/${projectId}/sessions`);
      if (command.json) {
        printJson(payload);
      } else if (payload.sessions.length === 0) {
        console.log("No sessions.");
      } else {
        for (const session of payload.sessions) {
          printSession(session);
        }
      }
      return 0;
    }

    case "sessions-create": {
      const projectId = requireProjectId(command.projectId, command.help);
      if (!command.help) {
        if (command.worktree) {
          if (!command.branchName) {
            throw new Error("Missing required option: --branch");
          }
          if (command.name) {
            throw new Error("--name cannot be used with --worktree");
          }
        } else if (command.branchName) {
          throw new Error("--branch requires --worktree");
        }
      }

      const body = command.worktree
        ? { mode: "worktree", branchName: command.branchName ?? "" }
        : { mode: "main", name: command.name };
      const created = await fetchJson<CreateSessionResult>(command, `/projects/${projectId}/sessions`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (command.json) {
        printJson(created);
      } else {
        console.log(`Created session ${created.session.id} in project ${created.session.projectId}`);
      }
      return 0;
    }

    case "sessions-get": {
      const projectId = requireProjectId(command.projectId, command.help);
      const sessionId = requireSessionId(command.sessionId, command.help);
      const session = await fetchJson<SessionMetadata>(command, `/projects/${projectId}/sessions/${sessionId}`);
      if (command.json) {
        printJson(session);
      } else {
        printSessionDetails(session);
      }
      return 0;
    }

    case "sessions-delete": {
      const projectId = requireProjectId(command.projectId, command.help);
      const sessionId = requireSessionId(command.sessionId, command.help);
      const payload = await fetchJson<{ ok: boolean }>(command, `/projects/${projectId}/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (command.json) {
        printJson(payload);
      } else {
        console.log(`Deleted session ${sessionId} from project ${projectId}`);
      }
      return 0;
    }

    case "sessions-lifecycle-set": {
      const projectId = requireProjectId(command.projectId, command.help);
      const sessionId = requireSessionId(command.sessionId, command.help);
      const lifecycleState = requireLifecycleState(command.lifecycleState, command.help);
      const payload = await fetchJson<SessionMetadata>(command, `/projects/${projectId}/sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ lifecycleState }),
      });
      if (command.json) {
        printJson(payload);
      } else {
        console.log(`Updated session ${payload.id} to ${payload.lifecycleState}`);
      }
      return 0;
    }

    case "serve":
      throw new Error("serve is not a client command");
  }
}

async function startServer(command: ServeCommand): Promise<number> {
  if (command.json) {
    throw new Error("--json is only supported for client commands");
  }

  const { server, stop } = createServer({
    host: command.host,
    ...(typeof command.port === "number" ? { port: command.port } : {}),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}. Shutting down Berm...`);
    await stop(true);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log(`Berm listening at ${server.url}`);
  return 0;
}

export async function runCli(argv = Bun.argv.slice(2)): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error("");
    console.error(usage());
    return 1;
  }

  if (command.help) {
    console.log(usage());
    return 0;
  }

  try {
    if (command.kind === "serve") {
      return await startServer(command);
    }

    return await handleClientCommand(command);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runCli();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
