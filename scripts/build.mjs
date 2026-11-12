import { build } from "esbuild";

await build({
  entryPoints: [
    "src/cli.ts",
    "src/controller.ts",
    "src/mcp.ts",
    "src/hooks/command.ts",
    "src/hooks/activity.ts",
    "src/hooks/session-context.ts",
  ],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: "dist",
  sourcemap: true,
  external: ["kimi"],
  logLevel: "info",
});
