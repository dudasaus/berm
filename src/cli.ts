import { createServer } from "./server/index";

export interface CliOptions {
  help: boolean;
  port?: number;
}

function usage(): string {
  return [
    "Usage: berm [--port <number>]",
    "",
    "Options:",
    "  -p, --port <number>  Port to listen on",
    "  -h, --help           Show this help text",
  ].join("\n");
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg === "-p" || arg === "--port") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }

      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }

      options.port = port;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export async function runCli(argv = Bun.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error("");
    console.error(usage());
    return 1;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  const { server, stop } = createServer(options.port === undefined ? {} : { port: options.port });

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

if (import.meta.main) {
  const exitCode = await runCli();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
