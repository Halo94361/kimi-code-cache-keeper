import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  skills?: string | string[];
  commands?: string | string[];
}

function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  fields["__body__"] = match[2]!.trim();
  return fields;
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(root, "kimi.plugin.json"), "utf8")) as Manifest;
}

function declaredPaths(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

test("manifest 声明的 skills 都可加载，入口名与目录一致", async () => {
  const manifest = await readManifest();
  const dirs = declaredPaths(manifest.skills);
  assert.ok(dirs.length > 0, "manifest 需要声明 skills，否则插件根目录只认单个 SKILL.md");

  const seen: string[] = [];
  for (const dir of dirs) {
    assert.match(dir, /^\.\//, `skills 路径必须是插件根内的相对路径：${dir}`);
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    assert.ok(entries.length > 0, `${dir} 下没有任何 Skill`);
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const text = await readFile(join(root, dir, entry.name, "SKILL.md"), "utf8");
      const fields = frontmatter(text);
      assert.equal(fields["name"], entry.name, `${entry.name}/SKILL.md 的 name 必须与目录名一致`);
      assert.ok((fields["description"] ?? "").length > 0, `${entry.name}/SKILL.md 缺少 description`);
      assert.ok((fields["__body__"] ?? "").length > 0, `${entry.name}/SKILL.md 正文不能为空`);
      seen.push(fields["name"]!);
    }
  }
  // CLI 的 commands 与 web 可用的 skills 需要一一对应，避免两端入口不一致
  const commands = (await readdir(join(root, declaredPaths(manifest.commands)[0]!), { withFileTypes: true }))
    .filter((item) => item.isFile() && item.name.endsWith(".md"))
    .map((item) => item.name.replace(/\.md$/, ""));
  assert.deepEqual(seen.sort(), commands.sort());
});

test("commands 的 Markdown 都有 description 与正文", async () => {
  const manifest = await readManifest();
  for (const dir of declaredPaths(manifest.commands)) {
    assert.match(dir, /^\.\//, `commands 路径必须是插件根内的相对路径：${dir}`);
    const files = (await readdir(join(root, dir), { withFileTypes: true }))
      .filter((item) => item.isFile() && item.name.endsWith(".md"));
    assert.ok(files.length > 0, `${dir} 下没有任何命令`);
    for (const file of files) {
      const fields = frontmatter(await readFile(join(root, dir, file.name), "utf8"));
      assert.ok((fields["description"] ?? "").length > 0, `${file.name} 缺少 description`);
      assert.ok((fields["__body__"] ?? "").length > 0, `${file.name} 正文不能为空`);
    }
  }
});
