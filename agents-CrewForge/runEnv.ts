import fs from "node:fs";
import path from "node:path";

const RUNS_ROOT = path.resolve("runs");

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