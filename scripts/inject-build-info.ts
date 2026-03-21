const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
let commitHash = "unknown";
try {
  commitHash = (await Bun.$`git rev-parse --short HEAD`.text()).trim();
} catch {
  // not in a git repo
}

const content = `export const version = ${JSON.stringify(pkg.version)};
export const commitHash = ${JSON.stringify(commitHash)};
`;

await Bun.write(new URL("../src/build-info.ts", import.meta.url), content);
console.log(`Injected build info: ${pkg.version} (${commitHash})`);
