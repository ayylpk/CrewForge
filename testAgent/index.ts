import "dotenv/config";
import readline from "readline";
import { setConfirmer } from "./src/permission";
// 9/13 结构定稿：main/context 改为动态 import——--verify 验收路径必须**结构性**
// 不加载模型链（models.ts 在模块顶层就 new ChatOpenAI，静态 import 会让零 LLM
// 承诺依赖"key 恰好配了"这种运气，而不是代码）。auto/chat 路径行为不变。

// ============================================================
// CLI 入口：--target 定位项目 / --auto 自动修复 / --json 结构化出口
//           / --verify 只读验收（独立验证器，见 src/verify.ts）
// ============================================================

/** --auto 的收敛上限（9/4 伤②）：旧版 999 裸奔，烧 token 且永不认错。
 *  30 = 约 10 个"跑测试→分析→修→回归"回合，终检场景够用，触顶强制收尾。 */
const AUTO_MAX_ITER = 30;

/** --json 出口契约（9/4 伤④）：给 CI / CrewForge 交付门消费的机器可读结论 */
interface FinalVerdict {
  verdict: "pass" | "fail" | "incomplete" | "error";
  testsPassed: boolean;
  summary: string;
  remainingIssues: string[];
}

/** 从模型收尾回复中提取 JSON 结论；解析失败不装死，降级 verdict=error 并留原文 */
function parseVerdict(raw: string): FinalVerdict {
  // 模型偶尔无视"不要围栏"，或把 JSON 包在解释文字里——剥围栏、取首 { 到末 }
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  const candidate = s >= 0 && e > s ? raw.slice(s, e + 1) : raw;
  try {
    const v = JSON.parse(candidate);
    const known = ["pass", "fail", "incomplete"].includes(v?.verdict);
    return {
      verdict: known ? v.verdict : "error",
      testsPassed: !!v?.testsPassed,
      summary: typeof v?.summary === "string" ? v.summary : "",
      // 防御（9/4 GREEN 实测）：skill 契约是字符串数组，但模型可能发 {issue,confidence} 对象——
      // 对象 stringify 兜底，绝不让一条真问题坏在 "[object Object]" 上
      remainingIssues: Array.isArray(v?.remainingIssues)
        ? v.remainingIssues.map((x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)))
        : [],
    };
  } catch {
    return {
      verdict: "error",
      testsPassed: false,
      summary: "模型最终回复不是合法 JSON",
      remainingIssues: [raw.slice(0, 500)],
    };
  }
}

async function main() {
  const args = process.argv.slice(2);

  // 解析 --target / --auto / --json
  let targetDir: string | undefined;
  let autoMode = false;
  let jsonMode = false;
  let verifyMode = false;
  let noLlmReview = false;
  let reviewTimeoutMs: number | undefined;
  let inputFile: string | undefined;
  const userArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && i + 1 < args.length) {
      targetDir = args[++i];
    } else if (args[i] === "--auto") {
      autoMode = true;
    } else if (args[i] === "--json") {
      jsonMode = true;
    } else if (args[i] === "--verify") {
      verifyMode = true;
    } else if (args[i] === "--yes") {
      // 无人值守时把"需要确认"的操作直接放行（opencode 的 permission:"allow" 同义）。
      // 默认**不是**这个 —— 默认是拒，因为无人可问时默默放行等于没有闸门。
      process.env.TESTAGENT_PERMISSION = "allow";
    } else if (args[i] === "--no-llm-review") {
      // 只跑机械段（不联网）。注意：关掉审查后 outcome 永远不是 pass——
      // "没有审查就不算通过"是刻意的，不能拿它当"放行开关"。
      noLlmReview = true;
    } else if (args[i] === "--review-timeout-ms" && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0) reviewTimeoutMs = n;
    } else if (args[i] === "--input" && i + 1 < args.length) {
      inputFile = args[++i];
    } else {
      userArgs.push(args[i]!);
    }
  }

  // ============================================================
  // 模式 V：只读验收（--verify --input <request.json>）
  //   两段式：① 机械验收（零 LLM，verdict 只由 exitCode/evidence/skipped 算）
  //           ② 语义审查（严格 LLM，只读、无工具；结论由纯函数裁决）
  //   不写目标项目 / 不猜命令；stdout 只有一份 JSON，日志全走 stderr。
  //   审查默认开（真实链必须过语义闸），--no-llm-review 可关（但关了不可能 pass）。
  // ============================================================
  if (verifyMode) {
    const { runVerify, verifyExitCode } = await import("./src/verify");
    let raw: unknown = null;
    if (!inputFile) {
      raw = null; // runVerify 会按"输入非法"出 error——契约优先于文案
    } else {
      try {
        raw = JSON.parse(await Bun.file(inputFile).text());
      } catch (e) {
        console.error(`❌ --input 读取/解析失败：${(e as Error).message}`);
      }
    }
    const result = await runVerify(raw, {
      review: {
        enabled: !noLlmReview,
        ...(reviewTimeoutMs !== undefined ? { timeoutMs: reviewTimeoutMs } : {}),
        log: (l) => console.error(l),
      },
    });
    if (!inputFile) result.error = `${result.error ?? ""}；缺 --input <request.json>`.trim();
    console.log(JSON.stringify(result));
    process.exit(verifyExitCode(result.verdict));
  }

  // 非 verify 路径：维持原有行为（此刻才允许加载上下文检测与模型链）
  const { runAgent } = await import("./src/main");
  const { detectContext, formatContext } = await import("./src/context");

  if (jsonMode && !autoMode) {
    console.error("⚠️ --json 仅配合 --auto 使用（需要可机器判定的终检结论）");
    process.exit(2);
  }

  // 切换到目标项目目录（如果有 --target）
  // 9/4 冒烟逮到的坑：目录不存在时 chdir 炸进 main().catch，只打日志照样 exit 0——CI 眼里等于成功
  if (targetDir) {
    try {
      process.chdir(targetDir);
    } catch {
      console.error(`❌ --target 目录不存在或不可进入: ${targetDir}`);
      process.exit(2);
    }
  }

  // 检测项目上下文
  const context = await detectContext();
  const contextStr = formatContext(context);
  // json 模式下 stdout 必须是纯 JSON，过程信息全走 stderr——方便 CI 管道直读
  const banner = jsonMode ? console.error : console.log;
  banner(`\n${contextStr}\n`);

  // 模式 A：自动修复模式
  if (autoMode) {
    // 伤③配套：检不出测试命令就 fail-fast，别拿空字符串让模型瞎跑
    if (!context.testCommand) {
      const verdict: FinalVerdict = {
        verdict: "error", testsPassed: false,
        summary: "未能从项目中检出测试命令（无 package.json/pom.xml/build.gradle）",
        remainingIssues: [context.cwd],
      };
      if (jsonMode) console.log(JSON.stringify(verdict, null, 2));
      else console.error(`❌ ${verdict.summary}`);
      process.exit(2);
    }

    let input =
      "若有匹配的可用技能，先 read 其 SKILL.md 全文再开始修复（未读前改码工具会被拦截）。\n" +
      `请运行测试命令 "${context.testCommand}"，分析所有失败的测试，逐一修复 bug，` +
      `然后再次运行测试验证。重复此过程直到所有测试通过。` +
      `如果遇到无法自动修复的问题，请说明原因。`;

    if (jsonMode) {
      input += "\n\n## 输出要求（最后一轮）\n" +
        "全部工作结束后，你的最后一条回复必须是**仅包含**下述字段的 JSON 对象（不要代码围栏、不要其他文字）：\n" +
        '{"verdict": "pass 或 fail 或 incomplete", "testsPassed": true 或 false, "summary": "一句话结论", "remainingIssues": ["未解决问题1", "..."]}\n' +
        "判定标准：pass=所有测试通过且你已重跑测试确认；fail=你已尽力但仍有测试失败；incomplete=达到迭代上限未能收敛。";
    }

    banner(`🤖 自动修复模式 (目标: ${context.projectName})\n`);
    // LLM/API 异常（402 余额不足、断网等）也必须走 JSON 出口——stdout 纯 JSON 是对 CI 的契约，
    // 不能塌成 stderr 堆栈（9/4 RED 首跑 402 暴露）
    let result;
    try {
      // 终检任务与终检技能是确定映射（auto==终检是业务事实），闸门不做语义判断（code-over-tools）
      result = await runAgent(input, context, AUTO_MAX_ITER, ["testing-before-delivery"]);
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 300);
      if (jsonMode) {
        console.log(JSON.stringify({
          verdict: "error", testsPassed: false,
          summary: `API/运行时异常，未得出可信结论: ${msg}`,
          remainingIssues: [],
        }, null, 2));
      } else {
        console.error(`❌ ${msg}`);
      }
      process.exit(2);
    }

    if (jsonMode) {
      const verdict = parseVerdict(result.answer);
      // 触顶强制收尾的回复是自由文本，多半解析不出 JSON——verdict 兜底 incomplete 才是诚实状态
      if (result.hitCap && verdict.verdict === "error") {
        verdict.verdict = "incomplete";
        verdict.summary = `达到迭代上限(${AUTO_MAX_ITER})被强制收尾；收尾原文: ${verdict.remainingIssues[0] ?? ""}`.slice(0, 300);
        verdict.remainingIssues = [];
      }
      console.log(JSON.stringify(verdict, null, 2));
      // 退出码约定：0=pass 1=有未解决问题(fail/incomplete) 2=结论不可信(error)
      process.exit(verdict.verdict === "pass" ? 0 : verdict.verdict === "error" ? 2 : 1);
    }

    console.log(result.answer);
    process.exit(result.hitCap ? 1 : 0);
  }

  // 模式 B：命令行单次问答
  if (userArgs.length > 0) {
    const input = userArgs.join(" ");
    console.log(`问: ${input}`);
    console.log("---");
    const result = await runAgent(input, context);
    console.log(result.answer);
    process.exit(0);
  }

  // 模式 C：交互模式
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  console.log("🤖 本地代码助手已启动（输入 exit 退出）\n");

  // ============================================================
  // 权限对话框（独立于对话输入，9/18）
  //   照 opencode / claude code / dsh 三家的同一套：ask 时弹一张卡，
  //   三个答案 —— 允许一次 / 始终允许 / 拒绝。
  //   为什么由这里注册：readline 归本文件所有。在 guard 里另开一个 readline
  //   会跟这个抢 stdin（输入会丢），所以把"怎么问人"注入进去，策略留在 permission.ts。
  //   注意：只在 TTY 下注册。非 TTY（管道/CI）注册了也没人答，permission.ts 那边
  //   本来就会把 ask 降级为拒。
  // ============================================================
  if (process.stdin.isTTY) {
    setConfirmer(async (d) => {
      const bar = "─".repeat(64);
      process.stdout.write(
        `\n${bar}\n` +
        `⚠️  需要你确认（${d.effect === "ask" ? "不在白名单" : d.effect}）：${d.reason}\n\n` +
        `    ${d.display}\n\n` +
        `  1) 允许一次    2) 始终允许（本会话记住：${d.key}）    3) 拒绝  [默认 3]\n${bar}\n`,
      );
      const ans = await new Promise<string>((resolve) => rl.question("选择 [1/2/3]: ", resolve));
      const t = ans.trim().toLowerCase();
      if (t === "1" || t === "y" || t === "yes") return "once";
      if (t === "2" || t === "a" || t === "always") return "always";
      return "no";
    });
  } else {
    console.error("ℹ️ 非 TTY：需要确认的操作一律按拒绝处理（无人可问）");
  }

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === "exit" || input === "quit") { rl.close(); return; }

    console.log("---");
    const result = await runAgent(input, context);
    console.log(result.answer);
    console.log("---");
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\n👋 再见");
    process.exit(0);
  });
}

// 兜底出口也要给非 0 退出码：走到这里说明是未预料崩溃，verdict=error 语义
main().catch((err) => { console.error(err); process.exit(2); });
