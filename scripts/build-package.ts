import tailwindPlugin from "bun-plugin-tailwind";

const outdir = new URL("../dist/", import.meta.url);

await Bun.$`rm -rf ${outdir.pathname}`;

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  format: "esm",
  outdir: outdir.pathname,
  plugins: [tailwindPlugin],
  root: "src",
  splitting: true,
  target: "bun",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }

  process.exit(1);
}

console.log(`Built package artifacts in ${outdir.pathname}`);
