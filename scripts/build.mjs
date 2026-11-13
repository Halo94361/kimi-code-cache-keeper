import { readFileSync } from "node:fs";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: [
    "src/cli.ts",
    "src/controller.ts",
    "src/mcp.ts",
    "src/hooks/activity.ts",
    "src/hooks/session-code.ts",
  ],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: "dist",
  sourcemap: true,
  external: ["kimi"],
  define: { __VERSION__: JSON.stringify(version) },
  logLevel: "info",
});
