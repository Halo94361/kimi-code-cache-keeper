import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withKimiAcp } from "./acp-client.js";
import { runProbe } from "./probe.js";
import { assertIsolatedHome, errorMessage } from "./safety.js";

interface CliOptions {
  command: "handshake" | "probe";
  home?: string;
  workspace?: string;
  kimiPath?: string;
  parentSessionId?: string;
  resumeDelaySeconds?: number;
}

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0] ?? "handshake";
  if (command !== "handshake" && command !== "probe") {
    throw new Error(`未知命令：${command}；可选 handshake 或 probe`);
  }
  const options: CliOptions = { command };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`${flag} 缺少参数值`);
    if (flag === "--home") options.home = value;
    else if (flag === "--workspace") options.workspace = value;
    else if (flag === "--kimi") options.kimiPath = value;
    else if (flag === "--session") options.parentSessionId = value;
    else if (flag === "--wait-seconds") {
      const seconds = Number(value);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86_400) {
        throw new Error("--wait-seconds 必须是 0 到 86400 的整数");
      }
      options.resumeDelaySeconds = seconds;
    } else throw new Error(`未知参数：${flag}`);
    i += 1;
  }
  return options;
}

function usage(): void {
  console.log(`用法：
  npm run probe -- handshake --home <隔离的KIMI_CODE_HOME> [--kimi <kimi路径>]
  npm run probe -- probe --home <隔离的KIMI_CODE_HOME> [--workspace <测试目录>] [--session <测试父会话ID>] [--wait-seconds <秒>]

probe 会创建真实模型请求；未指定 --session 时，测试父会话与 fork 都会在结束时删除。
指定 --wait-seconds 后，会在 fork 保活后等待，再恢复父会话做一次缓存验证。`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const home = assertIsolatedHome(options.home);
  const kimiOptions = options.kimiPath
    ? { home, kimiPath: options.kimiPath, allowCreatedParentCleanup: true }
    : { home, allowCreatedParentCleanup: true };

  if (options.command === "handshake") {
    const init = await withKimiAcp(kimiOptions, (driver) => driver.initialize());
    console.log(JSON.stringify({
      status: "ok",
      protocolVersion: init.protocolVersion,
      agentInfo: init.agentInfo ?? null,
      sessionCapabilities: init.agentCapabilities?.sessionCapabilities ?? null,
    }, null, 2));
    return;
  }

  const workspace = resolve(options.workspace ?? join(home, "workspace"));
  await mkdir(workspace, { recursive: true });
  const report = await withKimiAcp(kimiOptions, (driver) => runProbe(driver, {
    cwd: workspace,
    diagnosticsHome: home,
    ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.resumeDelaySeconds !== undefined
      ? { resumeDelaySeconds: options.resumeDelaySeconds }
      : {}),
  }));
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "ok") process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "error", error: errorMessage(error) }, null, 2));
  process.exitCode = 1;
});
