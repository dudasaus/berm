import tailwindPlugin from "bun-plugin-tailwind";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDir, "../berm");
const entrypoint = resolve(scriptDir, "../src/cli.ts");

const result = await Bun.build({
  entrypoints: [entrypoint],
  compile: {
    outfile: outputPath,
  },
  target: "bun",
  minify: true,
  plugins: [tailwindPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const entryOutput = result.outputs.find((output) => output.kind === "entry-point");
if (!entryOutput) {
  console.error("Compile succeeded but no entry-point output was produced.");
  process.exit(1);
}

if (entryOutput.path !== outputPath) {
  if (existsSync(outputPath)) {
    unlinkSync(outputPath);
  }
  renameSync(entryOutput.path, outputPath);
}

console.log(`Created ${outputPath}`);
