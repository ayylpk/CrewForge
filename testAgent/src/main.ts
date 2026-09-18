import { HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { spawn } from "node:child_process";
import { agent } from "./models";
import { Tools } from "./tool";
import {
  isRepairBashAllowed,
  isRepairPathAllowed,
  type ProjectContext,
  type RepairRequest,
  type RepairResult,
  formatContext,
} from "./context";
import { checkPermission, decideBash, decidePath, defaultGuard, scrubSecrets, type Guard } from "./permission";
import { loadSkills, skillsPrompt } from "./skills";

/**
 * runAgent 的结构化返回值（9/4 伤②④）：
 * index.ts 靠 hitCap 决定 --json 的 verdict 兜底、靠 iterations 汇报开销。
 */
export interface AgentRunResult {
  answer: string;
  iterations: number;
  /** 是否撞上迭代上限（未自然收敛，触顶被强制收尾） */
  hitCap: boolean;
}

// ---------- 消息压缩参数（伤②：修复循环里旧测试日志会塞爆 context） ----------
const KEEP_RECENT = 10;     // 最近 N 条消息保持完整
const COMPRESS_HEAD = 500;  // 更老的 ToolMessage 截首 N 字
const COMPRESS_TAIL = 500;  // 更老的 ToolMessage 截尾 N 字

/**
 * 压缩老工具结果：保留最近 KEEP_RECENT 条完整，更早的 ToolMessage 掐成"首尾各 500 字"。
 * 打 [已压缩] 标记保证幂等——后续每轮扫描不会反复重切已处理的消息。
 * 类比：JVM GC 只回收老生代，最近分配的对象（本轮要参考的报错）原样留着。
 */
function compressOldToolMessages(messages: BaseMessage[]): void {
  const cutoff = messages.length - KEEP_RECENT;
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i];
    if (!(m instanceof ToolMessage)) continue;
    const text = typeof m.content === "string" ? m.content : null;
    if (!text || text.startsWith("[已压缩]")) continue;
    if (text.length <= COMPRESS_HEAD + COMPRESS_TAIL + 200) continue; // 短消息不值得压缩还丢信息
    messages[i] = new ToolMessage({
      tool_call_id: m.tool_call_id,
      content: `[已压缩] ${text.slice(0, COMPRESS_HEAD)}\n... [中间 ${text.length - COMPRESS_HEAD - COMPRESS_TAIL} 字已压缩，该工具结果已被处理过] ...\n${text.slice(-COMPRESS_TAIL)}`,
    });
  }
}

/** 模型回复取纯文本（content 可能是 string，也可能是多段数组） */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c && typeof c === "object" && "text" in (c as any) ? (c as any).text : ""))
      .join("\n");
  }
  return "";
}

// ---------- 专修模式的进程内状态（由 runRepair 设置/清除） ----------
interface RepairGuard { allowedRoots: string[]; projectDir: string }
let activeRepairGuard: RepairGuard | null = null;
/** 本次专修实际写过的文件（绝对路径）——结论里如实上报 */
const touched = new Set<string>();

/**
 * 简单的 agent 循环
 * @param input 用户输入
 * @param cxt 项目上下文
 * @param maxIter 最大迭代次数（auto 模式传 30，见 index.ts AUTO_MAX_ITER）
 * @param requireSkillReads 开工闸门（9/4 GREEN 复盘）：这些 skill 未 read 全文前，
 *   edit/write 被机械拦截——渐进披露不能指望模型自觉（实测 flash 无视 L1 清单直接作弊）。
 *   bash/read/grep 始终放行：流程第一步"跑测试见基线红"本来就在读 skill 之前。
 */
export async function runAgent(
  input: string,
  cxt?: ProjectContext,
  maxIter = 999,
  requireSkillReads: string[] = [],
): Promise<AgentRunResult> {
  // 权限闸门的作用域（9/18）：
  //   被 CrewForge 驱动（专修模式）→ 用它给的三条根目录；
  //   本地自己跑（--auto / 交互 / 单次问答）→ 之前**根本没有闸门**，现在默认 root=启动目录。
  //   两者共用 permission.ts 的同一套裁决，不另写策略（政策一分叉就会漂移）。
  const guard: Guard | null = activeRepairGuard ?? defaultGuard();

  // 技能只扫一次：L1 注入与开工闸门共用同一份清单
  const skills = await loadSkills();

  // 构建系统提示词
  let prompt = "你是一个本地代码助手，负责修改 bug、优化代码、添加功能。\n" +
    "当前系统为 Windows (Git Bash)。\n\n" +
    "## 工具\n" +
    "- bash: 执行 shell 命令（编译、测试、运行）。超时标注 [TIMEOUT]，输出溢出标注 [OUTPUT_OVERFLOW]\n" +
    "- read: 读取文件内容，带行号显示，支持 offset/limit 分页续读。首次读取时自动生成索引\n" +
    "- grep: 搜索文件内容（支持正则表达式）\n" +
    "- edit: 精确替换文件中的内容（修改后自动更新索引）\n" +
    "- write: 整文件写入/新建（改已有文件优先用 edit）\n\n";

  // skills L1 注入（二期 E1）：只进 name+description，正文靠模型 read 渐进披露。
  // skills/ 目录不存在时返回空串——这正是 RED 基线（无 skill）的开关。
  prompt += skillsPrompt(skills);

  // 注入项目上下文
  if (cxt) {
    prompt += "## 项目上下文\n" + formatContext(cxt) + "\n\n";
  }

  // 9/4 二期 E3（搬家的证据在此注释留痕）：旧版硬编码的"## 工作流程"七条已整体迁入
  // skills/testing-before-delivery/SKILL.md——方法论归 skill，system prompt 只留
  // 角色 + 工具 + 技能清单 + 上下文。改纪律=改文档，不改代码。

  const SYSTEM_PROMPT = new SystemMessage(prompt);
  const messages: BaseMessage[] = [SYSTEM_PROMPT, new HumanMessage(input)];

  // 开工闸门状态：已读过的 required skill 名（read 工具命中 SKILL.md 路径时登记）
  const requiredSkills = requireSkillReads
    .map(n => skills.find(s => s.name === n))
    .filter((s): s is NonNullable<typeof s> => !!s);
  const readSkills = new Set<string>();

  /**
   * 预算到顶自动放宽一次（9/18，用户拍板："预算会自己增加一点，例如增加到 1.5 倍才停下"）。
   *
   * 为什么要放宽而不是硬停：撞上限常见于"已经看到出口、再补一两轮就能收"的场面
   * （典型是最后一次回归测试正在跑）。硬停在那一刻 = 把前面几十轮的进展白扔，
   * 而且产物停在半截、报告还说不出所以然。
   * 为什么只放宽**一次**：放宽两次就等于没有上限；模型一旦知道上限会自己长，试探行为会失控。
   * 所以是"一次止损"：给 1.5 倍把话说完，仍不收就按 incomplete 诚实交代。
   */
  const BUDGET_EXTEND_FACTOR = 1.5;
  let budgetExtended = false;

  for (let i = 0; i < maxIter; i++) {
    // 撞到上限前放宽一次（只放宽一次；交互模式 999 已经等于不限，不参与）
    if (!budgetExtended && maxIter <= 500 && i === maxIter - 1) {
      const next = Math.round(maxIter * BUDGET_EXTEND_FACTOR);
      console.error(`  [预算] 已达 ${maxIter} 轮，自动放宽到 ${next} 轮（只放宽一次，仍不收尾就按 incomplete 交代）`);
      maxIter = next;
      budgetExtended = true;
    }
    compressOldToolMessages(messages);
    // 预算提醒（9/4 复盘问题5）：模型不知道还剩几轮，会在第 28 轮才啃硬骨头撞上限。
    // 只在有限预算(≤50)时提醒一次，交互模式(999)不适用。措辞对齐 SKILL.md 流程第 5 条。
    if (maxIter <= 50 && i === Math.floor(maxIter * 0.75)) {
      messages.push(new HumanMessage(
        `迭代预算提醒：已用 ${i}/${maxIter} 轮，剩余不足 1/4。` +
        "按终检纪律：停止开辟新修复点，把已确认的问题归类进 remainingIssues、按报告契约收尾。"
      ));
    }
    const response = await agent.invoke(messages);
    messages.push(response);

    // 没有工具调用 = 模型给出最终回复，自然收敛
    if (!response.tool_calls?.length) {
      return { answer: textOf(response.content), iterations: i + 1, hitCap: false };
    }

    for (const tc of response.tool_calls) {
      // 可观测性（9/4 GREEN 复盘）：每步工具调用落 stderr——json 模式 stdout 必须纯 JSON。
      // 没有这行日志，eval 无法区分"没读 skill"和"读了 skill 仍作弊"，REFACTOR 就是盲调
      const argHint = String(tc.args?.command ?? tc.args?.address ?? tc.args?.file_path ?? tc.args?.pattern ?? "").slice(0, 80);
      console.error(`  [iter ${i + 1}] ${tc.name}: ${argHint}`);
      const tool = Tools.find((t) => t.name === tc.name);
      if (!tool) {
        messages.push(new ToolMessage({ content: `未知工具: ${tc.name}`, tool_call_id: tc.id! }));
        continue;
      }
      // —— 开工闸门：required skill 未读全文 → 机械拦截改码类工具（读文件/跑测试不拦） ——
      const pending = requiredSkills.filter(s => !readSkills.has(s.name));
      if (pending.length > 0 && (tc.name === "edit" || tc.name === "write")) {
        console.error(`  [gate] 拦截 ${tc.name}：未读 ${pending.map(s => s.name).join(",")}`);
        messages.push(new ToolMessage({
          content:
            `⛔ 开工前置未满足，${tc.name} 已被拦截。必须先 read 以下技能全文并按其规范执行：\n` +
            pending.map(s => s.path).join("\n") +
            `\n（bash/read/grep 不受限——可以先跑测试、看代码；读完技能后重试本次修改）`,
          tool_call_id: tc.id!,
        }));
        continue;
      }
      // —— 权限闸门（9/18）：五个工具**统一**走这里 ——
      //   原来只盖了 edit/write/bash，而且只在专修模式下开；read/grep 从来没管过，
      //   本地自己跑更是完全没闸门。现在：
      //     路径类（read/grep/edit/write）→ decidePath：秘密文件直接拒、越出 root 直接拒
      //     bash                            → decideBash：不可逆硬拒 / 白名单直放 / 其余弹窗问人
      //   ask 在无人值守时降级为拒（绝不"卡着等输入"或"默默放行"）。
      if (guard) {
        const decision =
          tc.name === "bash"
            ? decideBash(String(tc.args?.command ?? ""), guard)
            : tc.name === "read" || tc.name === "grep" || tc.name === "edit" || tc.name === "write"
              ? decidePath(tc.name, String(tc.args?.file_path ?? tc.args?.address ?? tc.args?.path ?? "."), guard)
              : null;
        if (decision) {
          const gate = await checkPermission(decision);
          if (gate.ok) {
            if (decision.effect !== "allow" || gate.note.includes("允许")) {
              console.error(`  [perm] 放行 ${tc.name}${gate.note ? " " + gate.note : ""}`);
            }
            if (tc.name === "edit" || tc.name === "write") touched.add(decision.display);
          } else {
            console.error(`  [perm] 拦截 ${tc.name}：${decision.reason}`);
            messages.push(new ToolMessage({
              content: `⛔ ${gate.note}\n（被拒的不是"你做错了"，是这台机器上不允许这么动。换成范围内/白名单内的做法重试；别试着绕过。）`,
              tool_call_id: tc.id!,
            }));
            continue;
          }
        }
      }
      try {
        const result = scrubSecrets(await (tool as any).invoke(tc.args) as string);
        messages.push(new ToolMessage({ content: result, tool_call_id: tc.id! }));
        // read 成功命中 required SKILL.md → 登记解锁
        if (tc.name === "read" && !result.startsWith("❌")) {
          const addr = String(tc.args?.address ?? "").replace(/\\/g, "/").toLowerCase();
          for (const s of requiredSkills) {
            if (addr === s.path.toLowerCase()) readSkills.add(s.name);
          }
        }
      } catch (err: any) {
        messages.push(new ToolMessage({ content: `执行错误: ${err.message}`, tool_call_id: tc.id! }));
      }
    }
  }

  // ---------- 伤②：触顶强制收尾 ----------
  // 旧版触顶只甩一句"已达最大迭代次数"，前面几十轮的修复进展全浪费了。
  // CrewForge 同款课（3 回炉/6 放弃）：到点就停，但停之前逼模型交代现状。
  messages.push(new HumanMessage(
    "你已达到迭代上限，立即停止调用任何工具、停止新的修复动作。" +
    "基于当前已知信息直接用文字总结：1) 已完成什么；2) 还有什么问题没解决；3) 未解决问题的具体报错是什么。"
  ));
  const finalRes = await agent.invoke(messages);
  const answer = textOf(finalRes.content) || "已达最大迭代次数，且模型未能给出收尾总结。";
  return { answer, iterations: maxIter, hitCap: true };
}

// ============================================================
// 专修入口（CrewForge engine2 第十二步）：RepairRequest → RepairResult
//
//   与 runAgent 的区别：结论**不来自模型的话**，只来自"重新执行原命令的退出码"。
//   · 只能改 allowedRoots（edit/write/bash 三处机械闸门）
//   · 不能改项目外（CrewForge 源码、本 agent 自身）、不能改 .git
//   · 每次修改后重新执行原命令；命令过了才算修好
//   · 预算耗尽 → incomplete；任何异常 → error（**返回 JSON，不抛未处理异常**）
// ============================================================

interface ExecOutcome { exitCode: number; output: string }

function execOnce(command: string, args: string[], cwd: string, timeoutMs = 600_000): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>(resolve => {
    let out = "";
    try {
      const child = spawn(command, args, {
        cwd,
        shell: process.platform === "win32",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        out += `\n[TIMEOUT ${timeoutMs}ms]`;
        try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      }, timeoutMs);
      child.stdout?.on("data", (d) => { out += String(d); });
      child.stderr?.on("data", (d) => { out += String(d); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ exitCode: -1, output: out + `\n${String(e)}` }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, output: out }); });
    } catch (e) {
      resolve({ exitCode: -1, output: String(e) });
    }
  });
}

/** 从命令输出里挑出还没解决的问题（只做呈现，不参与判定） */
function extractIssues(output: string, limit = 5): string[] {
  const lines = output.split(/\r?\n/).filter(l => /error|fail|exception|expected|✗|❌/i.test(l) && l.trim().length > 0);
  return [...new Set(lines.map(l => l.trim().slice(0, 240)))].slice(-limit);
}

function repairPrompt(req: RepairRequest, lastOutput: string, round: number): string {
  return [
    `【专修任务】第 ${round + 1} 轮。你只能修改这些目录/文件（其它一律被机械拒绝）：`,
    ...req.allowedRoots.map(r => `- ${r}`),
    ``,
    `失败命令（修完会自动重新执行同名命令，你不需要自己跑它）：`,
    `${req.command} ${req.args.join(" ")}`,
    `退出码：${req.evidence.exitCode ?? "unknown"}`,
    ``,
    `原始证据（stdout/stderr 片段）：`,
    (req.evidence.stdout || "(空)").slice(-2000),
    (req.evidence.stderr || "(空)").slice(-2000),
    ``,
    `最近一次重跑输出（同上命令）：`,
    lastOutput.slice(-2000),
    ``,
    `纪律：不许改验收条件、不许删测试、不许改验证命令；不许写项目目录之外的文件；`,
    `不许宣布"通过"——是否通过由重新执行命令的退出码决定。改完直接说明改了哪些文件即可。`,
  ].join("\n");
}

/**
 * 专修：跑测试 → 看报错 → 改 → 重跑，直到命令通过或预算耗尽。
 * ⚠️ 调用本函数会真实调用模型（由 CrewForge 编排器在有机器证据时触发）。
 */
export async function runRepair(req: RepairRequest): Promise<RepairResult> {
  touched.clear();
  let iterations = 0;
  try {
    const first = await execOnce(req.command, req.args, req.projectDir);
    if (first.exitCode === 0) {
      return { verdict: "unchanged", changedFiles: [], patchFile: null, iterations: 0, remainingIssues: [] };
    }
    activeRepairGuard = { allowedRoots: req.allowedRoots, projectDir: req.projectDir };
    let lastOutput = first.output;
    const budget = Math.max(1, req.maxIterations);
    while (iterations < budget) {
      await runAgent(repairPrompt(req, lastOutput, iterations), undefined, 30);
      iterations += 1;
      const after = await execOnce(req.command, req.args, req.projectDir);
      lastOutput = after.output;
      if (after.exitCode === 0) {
        return {
          verdict: "changed",
          changedFiles: [...touched].sort(),
          patchFile: null,
          iterations,
          remainingIssues: [],
        };
      }
    }
    return {
      verdict: "incomplete",
      changedFiles: [...touched].sort(),
      patchFile: null,
      iterations,
      remainingIssues: extractIssues(lastOutput),
    };
  } catch (e) {
    return {
      verdict: "error",
      changedFiles: [...touched].sort(),
      patchFile: null,
      iterations,
      remainingIssues: [String((e as Error)?.message ?? e).slice(0, 500)],
    };
  } finally {
    activeRepairGuard = null;
  }
}
