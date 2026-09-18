import fs from "node:fs";
import path from "node:path";

// 产物树根（A12）：Java spawn 时显式注入 RUNS_ROOT 指向仓库根 runs/；
// 未注入时退回 cwd/runs——保持手工 `bun run projectRunner.ts` 的旧习惯可用。
// 背景：曾有仓库根与引擎目录两份 runs/，起因就是这个 cwd 隐式对齐（9/3 F15 污染实锤）。
const RUNS_ROOT = path.resolve(process.env.RUNS_ROOT?.trim() || "runs");

export function currentProjectId(): number | null{
    const v = process.env.PROJECT_ID;;
    return v?Number(v):null;
}

export function projectDir(projectId: number): string {
  return path.join(RUNS_ROOT, `p${projectId}`);
}

export function safePath(projectId: number, relative: string): string {
  const room = path.resolve(projectDir(projectId));
  const abs = path.resolve(room, relative);
  const roomL = room.toLowerCase();
  const absL = abs.toLowerCase();
  if (absL !== roomL && !absL.startsWith(roomL + path.sep)) {
    throw new Error(`路径逃逸被拦截: ${relative}`);
  }
  return abs;
}

export function safeRealPath(projectId: number, relative: string): string {
  const abs = safePath(projectId, relative);
  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs);
    const roomReal = fs.realpathSync(projectDir(projectId));
    if (!real.toLowerCase().startsWith(roomReal.toLowerCase() + path.sep)) {
      throw new Error(`符号链接逃逸被拦截: ${relative}`);
    }
  }
  return abs;
}

export function safeExists(projectId: number, relative: string): boolean {
  try {
    return fs.existsSync(safeRealPath(projectId, relative));
  } catch {
    return false;
  }
}

/**
 * 重跑清场（F15 拍板：保历史不覆盖）：把旧产物树整体改名进 runs/_archive/pN-时间戳。
 * 只在"全新开工"（sys_task 无该proj行）时由 runner 调用——断点续跑不清场。
 * 返回归档后的路径；无旧树返回 null。rename 不删除，误伤可手动恢复。
 */
export function archiveProjectDir(projectId: number): string | null {
  const dir = projectDir(projectId);
  if (!fs.existsSync(dir)) return null;
  const archiveRoot = path.join(RUNS_ROOT, "_archive");
  fs.mkdirSync(archiveRoot, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  let dst = path.join(archiveRoot, `p${projectId}-${ts}`);
  for (let n = 1; fs.existsSync(dst); n++) dst = path.join(archiveRoot, `p${projectId}-${ts}-${n}`);
  fs.renameSync(dir, dst);
  return dst;
}