// ============================================================
// pm-cli.ts —— PM 独立试跑入口（解耦测试第一项："PM 是否会产出项目内容"）
//
//   用法：
//     bun pm-cli.ts --requirement <需求文件.md|需求文本> [--project-id p7] [--auto "答案1,答案2"] [--out <目录>]
//     bun pm-cli.ts --help
//
//   链路（真机，非测试）：需求原文 → manager.ts 的 generatePmContent 内容产面
//     （默认 deps = createLlmPmDeps：models.ts/initModels 的 DeepSeek 链，.env 由 bun 自动加载）
//     → 产物双写：
//       ① DB：sys_project.clarified_req / dev_plan（现有 saveClarifiedReq/saveDevPlan；
//          MySQL 连不上只 warn——本地产物照写，这是本 CLI 的立身之本）
//       ② 本地：<out>/clarified-req.md（人类可读的结构化澄清需求）
//                <out>/phase-plan.json（架构师 phase_plan 消费载荷数组，形状即 Hub 消息体）
//
//   提问器分流（确定性逻辑走代码，与 projectRunner 口径对齐）：
//     --auto "a,b"    → 脚本答案按序应答；用完仍未定稿 → 显式报错（末位自动补"定稿"除外，见下）
//     AUTO_CONFIRM=1  → 等价 --auto "定稿"（全绿灯单轮定稿，同 runner 的 isAuto 注入）
//     都没有          → CliQuestioner 真 stdin 交互
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { CliQuestioner } from "./GraphFactory";
import { generatePmContent, renderClarifiedReqMarkdown, type PmContentResult } from "./manager";

const USAGE = `用法: bun pm-cli.ts --requirement <需求文件.md|需求文本> [选项]
  --project-id pN|N   项目 id（默认 1；提供后同时落库 sys_project#N；phase_plan 载荷要求正整数）
  --auto "答案1,答案2" 脚本答案（逗号分隔，自动补末位"定稿"），不接终端
  --out <目录>        本地产物目录（默认 .runs/pm-cli-p<projectId>）
  -h, --help          看这个帮助`;

interface CliArgs {
    requirement?: string;
    projectIdRaw?: string;
    autoRaw?: string;
    out?: string;
    help: boolean;
}

/** 手写小解析（-x=v 与 -x v 两种姿势都收；未知参数显式报错） */
function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { help: false };
    const flagName = (a: string) => a.split("=")[0]!;
    const inlineValue = (a: string) => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : undefined);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        let value = inlineValue(a);
        if (value === undefined && !a.includes("=")) value = argv[++i];
        switch (flagName(a)) {
            case "--requirement": case "-r": args.requirement = value; break;
            case "--project-id": case "-p": args.projectIdRaw = value; break;
            case "--auto": case "-a": args.autoRaw = value; break;
            case "--out": case "-o": args.out = value; break;
            case "--help": case "-h": args.help = true; break;
            default: throw new Error(`未知参数：${a}\n${USAGE}`);
        }
    }
    return args;
}

/** p7 / 7 → 7；认不出的形状直接拒（宁缺勿错，防写错项目行） */
function parseProjectId(raw: string | undefined): number {
    if (!raw) return 1;
    const n = Number(raw.trim().replace(/^p/i, ""));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--project-id 需形如 p7 或 7，实际：${raw}`);
    return n;
}

/** 脚本答案：逗号（中英文皆可）分隔；末位不是"定稿"就补一条（--auto 的意图就是跑到定稿） */
function parseAnswers(raw: string | undefined): string[] {
    if (raw === undefined) return [];
    const list = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (list.length > 0 && !list[list.length - 1]!.includes("定稿")) list.push("定稿");
    return list;
}

async function loadRequirement(args: CliArgs, projectId: number): Promise<{ text: string; from: string }> {
    // ① --requirement：先按文件读；文件不存在则把值本身当内联需求文本
    if (args.requirement?.trim()) {
        const raw = args.requirement.trim();
        if (fs.existsSync(raw) && fs.statSync(raw).isFile()) {
            return { text: fs.readFileSync(raw, "utf-8").trim(), from: raw };
        }
        return { text: raw, from: "内联文本" };
    }
    // ② 没传 → 读库（sys_project.description + clarified_req）；DB 挂了给显式指引
    try {
        const { getProjectRequirement } = await import("./Node");
        const text = (await getProjectRequirement(projectId)).trim();
        if (text) return { text, from: `sys_project#${projectId}（description+clarified_req）` };
    } catch (e) {
        console.warn(`[pm-cli] 读库拿需求失败（MySQL 未启动？）: ${(e as Error).message}`);
    }
    return { text: "", from: "" };
}

/** 落库（现有函数，调用方职责——内容产面不碰 DB）：连不上只 warn，本地产物已写 */
async function writeBackToDb(result: PmContentResult): Promise<void> {
    try {
        const { saveClarifiedReq, saveDevPlan } = await import("./Node");
        await saveClarifiedReq(result.projectId, result.clarifiedReq.features);
        await saveDevPlan(result.projectId, result.plan);
        console.log(`[pm-cli] 已落库：sys_project#${result.projectId}.clarified_req / dev_plan`);
    } catch (e) {
        console.warn(`[pm-cli] DB 写入失败（MySQL 没启动？本地产物不受影响）: ${(e as Error).message}`);
    }
}

function writeLocalArtifacts(result: PmContentResult, outDir: string): void {
    fs.mkdirSync(outDir, { recursive: true });
    const mdFile = path.join(outDir, "clarified-req.md");
    const jsonFile = path.join(outDir, "phase-plan.json");
    fs.writeFileSync(mdFile, renderClarifiedReqMarkdown(result), "utf-8");
    fs.writeFileSync(jsonFile, JSON.stringify(result.phasePlans, null, 2), "utf-8");
    console.log(`[pm-cli] 本地产物：\n  ${mdFile}\n  ${jsonFile}（${result.phasePlans.length} 条 phase_plan 载荷，形状即架构师消费面）`);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(USAGE); return; }
    const projectId = parseProjectId(args.projectIdRaw);
    const outDir = path.resolve(args.out ?? path.join(".runs", `pm-cli-p${projectId}`));

    const { text: requirement, from: requirementFrom } = await loadRequirement(args, projectId);
    if (!requirement) {
        console.error(`[pm-cli] 拿不到需求原文：--requirement 没给（或文件为空），库里 p${projectId} 也没 description/clarified_req。\n${USAGE}`);
        process.exit(1);
    }

    // 提问者分流：--auto > AUTO_CONFIRM(="定稿") > CliQuestioner 真交互
    let answers = parseAnswers(args.autoRaw);
    const scripted = args.autoRaw !== undefined || process.env.AUTO_CONFIRM === "1";
    if (args.autoRaw === undefined && process.env.AUTO_CONFIRM === "1") answers = ["定稿"];
    console.log(`[pm-cli] 需求 ${requirement.length} 字（来源：${requirementFrom}）→ projectId=p${projectId}，提问器=${scripted ? "脚本" : "终端交互"}`);

    let questioner: CliQuestioner | null = null;
    const askUser = async (question: string, turn: number): Promise<string> => {
        if (answers.length > 0) {
            const a = answers.shift()!;
            console.log(`\n[PM] ${question}\n[auto ${turn}] ${a}`);
            return a;
        }
        if (scripted) throw new Error("脚本答案（--auto）用完仍未定稿：请在脚本末尾补一条定稿指令，或去掉 --auto 改终端交互");
        console.log(`\n[PM] ${question}`);
        questioner ??= new CliQuestioner();
        return questioner.ask({
            questionId: `pm-cli-${turn}`,
            prompt: "（输入下一句需求；输入 定稿 结束需求确认）",
            options: ["定稿"],
        });
    };

    // 真 LLM 走默认产面 deps（createLlmPmDeps）；对话/细化/规划全在 generatePmContent 里
    const result = await generatePmContent({ requirement, projectId }, { askUser });

    console.log(`[pm-cli] ✅ PM 定稿：${result.turns} 轮对话 / 确认功能 ${result.clarifiedReq.features.length} 项 → 细化 ${result.plan.features.length} 条 / ${result.plan.phases.length} 个阶段（${result.plan.phases.map(p => `阶段${p.phase}「${p.name}」`).join(" → ")}）`);
    void questioner;                       // CliQuestioner 的 readline 不主动关（GraphFactory 只读不改），
    writeLocalArtifacts(result, outDir);   // 先落本地：DB 挂不挂都看得见产物
    await writeBackToDb(result);           // 落库最后做：失败只 warn，进程由 import.meta.main 出口统一退出
}

if (import.meta.main) {
    main()
        .then(() => process.exit(0))
        .catch((e) => {
            console.error("[pm-cli] 失败:", e instanceof Error ? e.message : e);
            process.exit(1);
        });
}
