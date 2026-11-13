/**
 * 构建脚本从 package.json 注入的版本号常量（esbuild define）。
 * 直接跑 TS 源码时该标识符不存在，读取处用 typeof 兜底。
 */
declare const __VERSION__: string;
