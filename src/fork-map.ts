import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface ForkMapFile {
  version: 1;
  forks: Record<string, string>;
}

const FILE_VERSION = 1;

/**
 * 保活 fork 到父会话的临时映射。请求代理据此把 fork 请求的
 * x-opencode-session 换成父会话，恢复 OpenCode Go 的 prompt-cache 亲和。
 */
export class ForkMap {
  private readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(home: string) {
    this.path = join(home, "cache-keeper", "fork-map.json");
  }

  record(forkSessionId: string, parentSessionId: string): Promise<void> {
    return this.mutate((forks) => {
      forks[forkSessionId] = parentSessionId;
    });
  }

  forget(forkSessionId: string): Promise<void> {
    return this.mutate((forks) => {
      delete forks[forkSessionId];
    });
  }

  /** 控制器启动时清空：旧进程留下的 fork 已不存在，映射不再有意义 */
  clear(): Promise<void> {
    return this.mutate((forks) => {
      for (const id of Object.keys(forks)) delete forks[id];
    });
  }

  private mutate(change: (forks: Record<string, string>) => void): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        const forks = await this.read();
        change(forks);
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ version: FILE_VERSION, forks }), { mode: 0o600 });
        await rename(tmp, this.path);
      })
      .catch(() => {});
    return this.queue;
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as ForkMapFile;
      if (parsed.version === FILE_VERSION && parsed.forks && typeof parsed.forks === "object") {
        return { ...parsed.forks };
      }
    } catch {
      // 缺失或损坏按空映射处理
    }
    return {};
  }
}
