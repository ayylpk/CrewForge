// ============================================================
// finalGate.ts —— 交付前最后一关：项目"完成"必须等于"验证通过"
//
//   动机：现在 runner 是"全阶段跑完 → status=done"。而 runs/p9 的实况是——
//   阶段全过、status 落 done，产物却**根本编译不过**（3 处幻觉 API）。也就是说
//   "完成"这个词此前是流程意义上的，不是结果意义上的。
//
//   本关把两者绑起来：
//     · 验证通过        → done（verified）
//     · 编译/启动/契约失败 → **failed**（带报告，不静默）
//     · 无验证器/无 Docker/无可验证对象 → done 但**显式标注未验证**（未验证 ≠ 通过）
//   报告一律落 _verify/run-report.md（证据链，人可复核）。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { verifyRun, renderRunVerifyReport, type RunVerifyResult, type RunVerifyOpts } from "../exec/verify/runVerify";
import { acceptanceFromTasks, type TaskLike } from "../ir/contract";
import { activeScenarioSpec, acceptanceFromScenarioSpec, resolveAcceptanceCode } from "../ir/scenarioSpec";
import { resolveStackProfile } from "../stacks/profile";
import { resolveProjectBaseline, PROJECT_BASELINE } from "../../baseline";

/**
 * 交付关结论（★ 阶段 1 提交 1：把"判定不出来"从 done 里拆出来）
 *   done               —— 执行式验证真的跑过并且通过（verified=true）
 *   failed             —— 编译/启动/契约失败，或交付关自身异常
 *   skipped_unverified —— 没有验证器 / 没有可验证对象 / Docker 不可用 / 显式跳过：
 *                         **未验证 ≠ 通过**，由 decideProjectStatus 映射成项目级 blocked
 */
export type FinalGateStatus = "done" | "failed" | "skipped_unverified";

export interface FinalGateResult {
    status: FinalGateStatus;
    /** 是否**真的**跑过执行式验证并通过（false 时不得对外宣称"已验证"） */
    verified: boolean;
    summary: string;
    reportFile: string | null;
    verify?: RunVerifyResult;
}

export interface FinalGateOpts {
    projectDir: string;
    tasks: TaskLike[];
    /** 产物树里的验收 IR 文件（architect 在每阶段下发时落盘）；给了就优先用它，读不到再退回 tasks */
    acceptanceFiles?: string[];
    /** 项目最终技术选型（architect stack） */
    stack?: unknown;
    /** 跳过开关（快速迭代用；跳过的结果一律 verified=false） */
    skip?: boolean;
    /** 需求原文（用于从需求里机械解析统一响应成功码；给了就不读库） */
    requirementText?: string;
    /**
     * 数据库来源（★ 阶段 1）：docker=容器；host=**宿主 MySQL 验证**；auto=默认（Docker 优先，回退宿主）
     */
    dbMode?: "docker" | "host" | "auto";
    /** 测试注入：替掉真实 verifyRun */
    verify?: (o: RunVerifyOpts) => Promise<RunVerifyResult>;
    logDir?: string;
}

/** 读并合并多个验收 IR 文件（按 id 去重）；返回 cases 与文件级问题说明 */
function loadAcceptanceFiles(files: string[]): { cases: unknown[]; notes: string[] } {
    const cases: unknown[] = [];
    const notes: string[] = [];
    const seen = new Set<string>();
    for (const f of files) {
        if (!fs.existsSync(f)) continue;
        try {
            const parsed = JSON.parse(fs.readFileSync(f, "utf-8")) as { cases?: unknown[] };
            for (const c of parsed.cases ?? []) {
                const id = (c as { id?: string })?.id ?? "";
                if (id && seen.has(id)) continue;
                if (id) seen.add(id);
                cases.push(c);
            }
        } catch (e) {
            notes.push(`${path.basename(f)} 解析失败：${String((e as Error).message ?? e).slice(0, 80)}`);
        }
    }
    return { cases, notes };
}

export async function finalGate(o: FinalGateOpts): Promise<FinalGateResult> {
    const logDir = o.logDir ?? path.join(o.projectDir, "_verify");
    const baseline = resolveProjectBaseline(o.stack ?? undefined);
    const profile = resolveStackProfile(baseline);

    const finish = (status: FinalGateStatus, verified: boolean, summary: string, verify?: RunVerifyResult): FinalGateResult => {
        let reportFile: string | null = null;
        if (verify) {
            try {
                fs.mkdirSync(logDir, { recursive: true });
                reportFile = path.join(logDir, "run-report.md");
                fs.writeFileSync(reportFile, renderRunVerifyReport(verify), "utf-8");
            } catch { reportFile = null; }
        }
        return { status, verified, summary, reportFile, verify };
    };

    if (o.skip) {
        return finish("skipped_unverified", false, "已按 SKIP_RUN_VERIFY 跳过执行式验证：本结果为**未验证**，不得对外宣称已验证");
    }
    if (!profile.verified) {
        return finish("skipped_unverified", false, `本栈无验证器（${profile.id}）：未验证交付（不计入通过）`);
    }

    // 验收来源优先级：产物树的验收 IR（architect 落盘，带 method/path）> 从任务字段推导
    let cases: AcceptanceLike[] = [];
    const notes: string[] = [];
    if (o.acceptanceFiles?.length) {
        const loaded = loadAcceptanceFiles(o.acceptanceFiles);
        cases = loaded.cases as AcceptanceLike[];
        notes.push(...loaded.notes);
    }
    let skippedCount = 0;
    if (cases.length === 0) {
        // ★ 阶段 1 提交 3：回退顺序 = 冻结场景规格（验收来自需求） → 任务字段 + 需求解析出的成功码。
        //   旧实现直接用 baseline.response.successCode(=1)，与冻结需求的 code=200 冲突。
        const active = activeScenarioSpec();
        if (active) {
            const built = acceptanceFromScenarioSpec(active.spec);
            cases = built.cases as AcceptanceLike[];
            skippedCount = built.skipped.length;
            notes.push(`验收来源：场景规格 ${active.spec.id}（${active.file}）`);
        } else {
            let requirementText: string | null = null;
            if (o.requirementText !== undefined) requirementText = o.requirementText;
            const code = resolveAcceptanceCode(requirementText);
            const derived = acceptanceFromTasks(o.tasks, {
                apiPrefix: baseline.apiPrefix || PROJECT_BASELINE.apiPrefix,
                ...(code.successCode != null ? { successCode: code.successCode } : {}),
            });
            cases = derived.cases as AcceptanceLike[];
            skippedCount = derived.skipped.length;
            notes.push(`验收来源：任务字段 + ${code.source}（${code.evidence}）`);
        }
    }
    if (cases.length === 0) {
        return finish("skipped_unverified", false,
            `无可验证对象${notes.length ? `（${notes.join("；")}）` : ""}${skippedCount ? `（跳过 ${skippedCount} 个缺 method/path 的任务）` : ""}：未验证交付`);
    }

    const run = o.verify ?? verifyRun;
    const res = await run({
        projectDir: o.projectDir,
        profile,
        cases: cases as RunVerifyOpts["cases"],
        logDir,
        ...(o.dbMode ? { dbMode: o.dbMode } : {}),
    });

    const modeNote = res.dbMode === "host" ? "（**宿主验证**：宿主 MySQL + 本机 JVM，非容器隔离）" : "";
    if (res.outcome === "ok") {
        return finish("done", true, `执行式验证通过${modeNote}：${cases.length} 条契约断言全过`, res);
    }
    if (res.outcome === "skipped_unverified") {
        return finish("skipped_unverified", false, `${res.summary}（未验证 ≠ 通过，报告见 _verify/run-report.md）`, res);
    }
    // compile/boot/contract 失败 = 项目不算完成
    return finish("failed", false, `执行式验证未通过（${res.outcome}）：${res.summary}；共 ${res.failures.length} 条失败原因`, res);
}

/** 验收条目形状（避免把 ir 的类型硬编进签名，便于读文件） */
type AcceptanceLike = { id?: string; kind?: string };
