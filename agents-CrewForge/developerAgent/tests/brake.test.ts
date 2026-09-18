// tests/brake.test.ts —— 团队开发线的外层刹车（墙钟 + 调用数）纯函数与 env 解析
//
//   为什么值得单独钉死：这道闸原先**不存在**（预算被写成 Number.MAX_SAFE_INTEGER、明确不加墙钟），
//   代价是 eval-s4 3608s / s4c·s4d 5409s / s5b 7209s 四次实跑全被外层 eval 驱动器杀死，
//   sys_project.status 停在 executing —— 60~120 分钟真实花费，零结论零死因（s4c/s4d 被杀时
//   HTTP 判据已经 6/6 全绿）。闸门本身是纯函数，边界（"刚好到点算不算到点"）必须钉在测试里，
//   否则下一个人改一个 `>` 就悄悄把闸推后一个完整调用窗口。
//
//   ★★ 2026-09-17 三改语义（老板最终口径）：**不杀了，参照 Claude Code**。
//     「不杀了，就参考 claudecode，一直进行下去，然后如果到阈值了，静默一段时间等待确认，
//       如果没有确认我们就把进程终止，任务信息保留，下次可以继续接着拉起来进程。」
//     所以本文件里断言的是：
//       · 到阈值 = **检查点**（tripped 只表示"该问人了"，不表示"该死了"）；
//       · Web/手工跑法**没有天花板**：越过 CF_HARD_WALL_MINUTES 也只是继续问人/继续等，
//         hard 永远是 false（不杀）；
//       · 只有**无人值守（AUTO_CONFIRM=1）**那条路才有天花板兜底（hard=true → 自保收口）；
//       · 静默等待窗口可配（CF_BRAKE_WAIT_MINUTES，默认 30 分钟），等满了不是错误，是"人不在"。
//
//   本文件零 LLM、零网络、零 DB。驱动环（问→等→继续/保状态退出）见 brake-driver.test.ts。
import { describe, expect, it } from "bun:test";
import {
    acceptanceGreen, askBrakeQuietly, brakeEventName, brakeLogLine, brakeOptions, brakeQuestion,
    brakeQuestionId, brakeReasonLabel, brakeReasonText, buildProgressReport, checkBrake,
    countExtensions, DEFAULT_EXTEND_LLM_CALLS, DEFAULT_EXTEND_MINUTES, DEFAULT_MAX_LLM_CALLS, DEFAULT_MAX_WALL_MINUTES,
    DEFAULT_WAIT_MINUTES, ENV_AUTO_CONFIRM, ENV_EXTEND_LLM_CALLS, ENV_EXTEND_MINUTES, ENV_HARD_WALL_MINUTES,
    ENV_MAX_LLM_CALLS, ENV_MAX_WALL_MINUTES, ENV_WAIT_MINUTES, formatElapsed, formatMinutes,
    grantBrakeExtension, isUnattended, lastFailureReason, MAX_LLM_CALLS_CAP, MAX_WALL_MINUTES_CAP,
    parseBrakeAnswer, parsePositiveNumberEnv, remainingWallMs, resolveBrakePolicy,
    type BrakePolicy, type BrakeQuestioner, type BrakeSummary,
} from "../brake";

/**
 * 定格一个 policy（不读真 env，也不吃 Date.now()）：默认档 120 分钟 / 400 调 / 等待 30 分钟。
 * ⚠️ maxWallMs / hardWallMs 都是**时长**（checkBrake 拿 elapsedMs 比它们），绝对时刻是 deadlineAt。
 * 默认 unattended=false（Web/手工跑法）——天花板对它不生效，这正是"不杀"的落点。
 */
const policyAt = (over: Partial<BrakePolicy> = {}): BrakePolicy => ({
    maxWallMs: 120 * 60_000,
    maxLlmCalls: 400,
    initialMaxLlmCalls: 400,
    startedAt: 1_000_000,
    deadlineAt: 1_000_000 + 120 * 60_000,
    hardWallMs: 180 * 60_000,
    hardLlmCalls: 800,
    waitMs: 30 * 60_000,
    extendMinutes: 30,
    extendLlmCalls: 200,          // ★ 9/18：一次"继续"补多少调用（与墙钟一起前移）
    extensionsUsed: 0,
    unattended: false,
    source: { wallMinutes: 120, fromEnv: [] },
    ...over,
});

/** 时长夹具：把"能跑多久（分钟）"写成**时长**（与 elapsedMs 同一把尺子） */
const mins = (n: number): number => n * 60_000;

/** 定格一个摘要（进展报告与题面的输入；数字刻意都是可辨认的） */
const summaryAt = (over: Partial<BrakeSummary> = {}): BrakeSummary => ({
    taskId: "t1", status: "implementing",
    elapsedMs: mins(121), maxWallMs: mins(120), hardWallMs: mins(180),
    callsCompleted: 147, callsAllowance: 400, hardCalls: 800,
    changedFiles: 7, workItemsDone: 3, workItemsTotal: 5, remaining: ["w4", "w5"],
    toolCalls: 61, repairAttempts: 2, checksGreen: 4, checksTotal: 12,
    lastError: "ACCEPTANCE-3 期望 200 实得 500",
    extensionsUsed: 0, waitMs: mins(30), extendMinutes: 30,
    ...over,
});

describe("刹车·检查点判定（checkBrake：只回答该不该问人）", () => {
    it("未到点 + 额度没用完 → 不触发", () => {
        const s = checkBrake(policyAt(), { callsCompleted: 399, elapsedMs: mins(119) });
        expect(s.tripped).toBe(false);
        expect(s.reason).toBeNull();
        expect(s.hard).toBe(false);
    });

    it("越过墙钟 SOFT → wall_clock（这只是「该问人了」，不是「该死了」）", () => {
        const s = checkBrake(policyAt(), { callsCompleted: 0, elapsedMs: mins(120) + 1 });
        expect(s.tripped).toBe(true);
        expect(s.reason).toBe("wall_clock");
        expect(s.hard).toBe(false);
        expect(s.elapsedMs).toBe(mins(120) + 1);
    });

    it("刚好跑到 SOFT 上 → **算到点**（与 isBudgetExceeded 的 >= 口径同族：上限是可用量，不是再多跑一点）", () => {
        const s = checkBrake(policyAt(), { callsCompleted: 10, elapsedMs: mins(120) });
        expect(s.tripped).toBe(true);
        expect(s.reason).toBe("wall_clock");
    });

    it("★ Web/手工跑法**没有天花板**：越过 CF_HARD_WALL_MINUTES 也只是继续问人（hard 永远 false）", () => {
        const s = checkBrake(policyAt({ unattended: false }), { callsCompleted: 10, elapsedMs: mins(500) });
        expect(s.tripped).toBe(true);
        expect(s.reason).toBe("wall_clock");
        expect(s.hard).toBe(false);            // ★ 不杀：这条路上没有"到顶就死"
    });

    it("★ 只有无人值守（AUTO_CONFIRM=1）才有天花板：越过它 hard=true（自保收口，免得评测台挂住）", () => {
        const s = checkBrake(policyAt({ unattended: true }), { callsCompleted: 10, elapsedMs: mins(180) + 1 });
        expect(s.tripped).toBe(true);
        expect(s.hard).toBe(true);
        // 差一点点（还没入天花板）→ 仍然只是问人
        expect(checkBrake(policyAt({ unattended: true }), { callsCompleted: 10, elapsedMs: mins(179) }).hard).toBe(false);
    });

    it("越过调用预算 → llm_budget（墙钟还早得很）", () => {
        const s = checkBrake(policyAt(), { callsCompleted: 401, elapsedMs: mins(1) });
        expect(s.tripped).toBe(true);
        expect(s.reason).toBe("llm_budget");
        expect(s.callsCompleted).toBe(401);
        expect(s.hard).toBe(false);
    });

    it("刚好用完最后一调（completed === max）→ **算到顶**（复用 isBudgetExceeded：达到上限不得再发请求）", () => {
        const s = checkBrake(policyAt(), { callsCompleted: 400, elapsedMs: mins(1) });
        expect(s.tripped).toBe(true);
        expect(s.reason).toBe("llm_budget");
    });

    it("399/400 仍可继续（额度是真的用了 400 次才到顶）", () => {
        expect(checkBrake(policyAt(), { callsCompleted: 399, elapsedMs: 0 }).tripped).toBe(false);
    });

    it("加时后的**允许量**与 handle 预算取 min（callsAllowance 是驱动环的读数口径）", () => {
        const s = checkBrake(policyAt(), { callsCompleted: 147, elapsedMs: mins(1), callsAllowance: 147 });
        expect(s.tripped).toBe(true);
        expect(s.reason).toBe("llm_budget");
        expect(s.maxLlmCalls).toBe(147);                  // 报告里写的是允许量，不是 policy 上限
        // 加时后允许量抬到 347（handle 预算 + 200），147 那一调还在预算内 → 不再到点
        expect(checkBrake(policyAt({ maxLlmCalls: 600 }), {
            callsCompleted: 147, elapsedMs: mins(1), callsAllowance: 347,
        }).tripped).toBe(false);
    });

    it("两者同时到顶 → 先报墙钟（时间不可逆，且外层杀进程走的就是这条路）", () => {
        const s = checkBrake(policyAt(), { callsCompleted: 999, elapsedMs: mins(120) });
        expect(s.reason).toBe("wall_clock");
    });

    it("时钟被往回调（elapsed 为负）→ 夹到 0，不许误判成超时", () => {
        const s = checkBrake(policyAt(), { callsCompleted: 0, elapsedMs: -5_000 });
        expect(s.tripped).toBe(false);
        expect(s.elapsedMs).toBe(0);
    });

    it("还剩多久：到点后恒为 0，不到点是差值（给等待窗口定界用）", () => {
        const p = policyAt();
        expect(remainingWallMs(p, p.startedAt)).toBe(mins(120));
        expect(remainingWallMs(p, p.deadlineAt + 1)).toBe(0);
    });
});

describe("刹车·参数解析（env 与默认值）", () => {
    it("空 env → 默认档：120 分钟 / 400 调 / 静默等待 30 分钟（SOFT 是检查点，两个上限都默认 ON）", () => {
        const p = resolveBrakePolicy({}, 1_000);
        expect(p.maxWallMs).toBe(DEFAULT_MAX_WALL_MINUTES * 60_000);
        expect(p.maxLlmCalls).toBe(DEFAULT_MAX_LLM_CALLS);
        expect(p.initialMaxLlmCalls).toBe(DEFAULT_MAX_LLM_CALLS);
        expect(p.waitMs).toBe(DEFAULT_WAIT_MINUTES * 60_000);
        expect(p.startedAt).toBe(1_000);
        expect(p.deadlineAt).toBe(1_000 + DEFAULT_MAX_WALL_MINUTES * 60_000);
        expect(p.source.fromEnv).toEqual([]);
        expect(p.unattended).toBe(false);          // 默认是"有人"的跑法：不杀
    });

    it("★ 墙钟默认从 45 抬到 120：老板的要求是「让它能跑完再问人」，不是「45 分钟就打断」", () => {
        expect(DEFAULT_MAX_WALL_MINUTES).toBe(120);
    });

    it("★ 静默等待窗口默认 30 分钟，可配 CF_BRAKE_WAIT_MINUTES（与 Java 确认门的 30 分钟同源）", () => {
        expect(DEFAULT_WAIT_MINUTES).toBe(30);
        expect(resolveBrakePolicy({ [ENV_WAIT_MINUTES]: "5" }).waitMs).toBe(mins(5));
        expect(resolveBrakePolicy({ [ENV_WAIT_MINUTES]: "1" }).waitMs).toBe(60_000);
    });

    it("AUTO_CONFIRM=1 → unattended=true（这条路才用天花板；评测台不会被卡住也不会跑飞）", () => {
        expect(isUnattended({ [ENV_AUTO_CONFIRM]: "1" })).toBe(true);
        expect(isUnattended({})).toBe(false);
        expect(resolveBrakePolicy({ [ENV_AUTO_CONFIRM]: "1" }).unattended).toBe(true);
        expect(resolveBrakePolicy({ [ENV_AUTO_CONFIRM]: "0" }).unattended).toBe(false);
    });

    it("CF_MAX_WALL_MINUTES=90 → 90 分钟；CF_MAX_LLM_CALLS=250 → 250 调，且点名来源", () => {
        const p = resolveBrakePolicy({ [ENV_MAX_WALL_MINUTES]: "90", [ENV_MAX_LLM_CALLS]: "250" });
        expect(p.maxWallMs).toBe(mins(90));
        expect(p.maxLlmCalls).toBe(250);
        expect(p.source.fromEnv).toEqual([ENV_MAX_WALL_MINUTES, ENV_MAX_LLM_CALLS]);
    });

    it("无人值守天花板：不配 = SOFT + 一跳加时；配了照配；配得比 SOFT 小 → 抬到 SOFT（不许倒挂）", () => {
        expect(resolveBrakePolicy({}, 1_000).hardWallMs)
            .toBe((DEFAULT_MAX_WALL_MINUTES + DEFAULT_EXTEND_MINUTES) * 60_000);
        expect(resolveBrakePolicy({ [ENV_HARD_WALL_MINUTES]: "300" }).hardWallMs).toBe(mins(300));
        const inverted = resolveBrakePolicy({ [ENV_HARD_WALL_MINUTES]: "10" });
        expect(inverted.hardWallMs).toBe(inverted.maxWallMs);
        expect(resolveBrakePolicy({ [ENV_EXTEND_MINUTES]: "5" }).extendMinutes).toBe(5);
    });

    it("垃圾值回落默认（绝不变成 0/NaN：0 分钟 = 一开工就判超时，NaN = 闸永不触发）", () => {
        for (const garbage of ["", " ", "abc", "NaN", "0", "-5", "1e999", "１２３"]) {
            const p = resolveBrakePolicy({
                [ENV_MAX_WALL_MINUTES]: garbage, [ENV_MAX_LLM_CALLS]: garbage,
                [ENV_WAIT_MINUTES]: garbage, [ENV_HARD_WALL_MINUTES]: garbage,
                [ENV_EXTEND_MINUTES]: garbage,
            });
            expect(p.maxWallMs).toBe(DEFAULT_MAX_WALL_MINUTES * 60_000);
            expect(p.maxLlmCalls).toBe(DEFAULT_MAX_LLM_CALLS);
            expect(p.waitMs).toBe(DEFAULT_WAIT_MINUTES * 60_000);
            // 等待窗口绝不许是 0：0 分钟的"静默等"等于"立刻退出"，那就不是"等人"了
            expect(p.waitMs).toBeGreaterThan(0);
            expect(p.extendMinutes).toBeGreaterThan(0);
        }
    });

    it("整数化 + 硬上限：120.9 → 120（宁可早停）；720 分钟以上夹到 720；调用数夹到 4000", () => {
        expect(resolveBrakePolicy({ [ENV_MAX_WALL_MINUTES]: "120.9" }).maxWallMs).toBe(mins(120));
        expect(resolveBrakePolicy({ [ENV_MAX_WALL_MINUTES]: "99999" }).maxWallMs).toBe(MAX_WALL_MINUTES_CAP * 60_000);
        expect(resolveBrakePolicy({ [ENV_MAX_LLM_CALLS]: "999999" }).maxLlmCalls).toBe(MAX_LLM_CALLS_CAP);
        expect(DEFAULT_MAX_WALL_MINUTES).toBeLessThanOrEqual(MAX_WALL_MINUTES_CAP);
        expect(DEFAULT_MAX_LLM_CALLS).toBeLessThanOrEqual(MAX_LLM_CALLS_CAP);
    });

    it("parsePositiveNumberEnv 单测：非法/非正 → 回落；合法取整", () => {
        expect(parsePositiveNumberEnv(undefined, 7)).toBe(7);
        expect(parsePositiveNumberEnv("0", 7)).toBe(7);
        expect(parsePositiveNumberEnv("-1", 7)).toBe(7);
        expect(parsePositiveNumberEnv("xyz", 7)).toBe(7);
        expect(parsePositiveNumberEnv("Infinity", 7)).toBe(7);
        expect(parsePositiveNumberEnv(" 30 ", 7)).toBe(30);
        expect(parsePositiveNumberEnv("30.8", 7)).toBe(30);
    });
});

describe("刹车·加时（人就答继续时唯一改期限的地方）", () => {
    it("加时把期限从**现在**往前推 30 分钟，并计数（次数进账本 brake_extended）", () => {
        const p = policyAt();
        const now = p.startedAt + mins(121);
        const g = grantBrakeExtension(p, now);
        expect(g).toEqual({ index: 1 });
        expect(p.maxWallMs).toBe(mins(150));
        expect(p.deadlineAt).toBe(now + mins(30));
        expect(p.extensionsUsed).toBe(1);
        expect(checkBrake(p, { callsCompleted: 147, elapsedMs: mins(121) }).tripped).toBe(false);
    });

    it("可以一直追加时（**不设次数上限**——参照 Claude Code，一直进行下去）", () => {
        const p = policyAt();
        let now = p.startedAt + mins(121);
        for (let i = 1; i <= 5; i++) {
            grantBrakeExtension(p, now);
            expect(p.extensionsUsed).toBe(i);
            expect(checkBrake(p, { callsCompleted: 147, elapsedMs: now - p.startedAt }).tripped).toBe(false);
            now += mins(31);            // 走完这一跳又到点
        }
        expect(p.extensionsUsed).toBe(5);
    });

    it("countExtensions 从账本事件重建加时次数（停机续跑时 policy 是新的，次数得从账本捞回来）", () => {
        expect(countExtensions([])).toBe(0);
        expect(countExtensions([
            { type: "brake_extended" }, { type: "brake_paused" }, { type: "brake_extended" },
        ])).toBe(2);
    });

    // ★ 9/18 加（治"加时加了个寂寞"）——s1-crud-min 实测死法：调用数 138/138 到顶、
    //   活几乎干完（25 文件、ac-1/ac-2 都 exit=0），人答"继续"却救不回调用数，
    //   两次求助额度烧完判 blocked。加时必须**两个钟一起前移**。
    it("★ 加时同时抬高调用数上限（原先只加墙钟 → 对「调用数耗尽」的任务是空操作）", () => {
        const p = policyAt();                       // maxLlmCalls=400, hardLlmCalls=800, extendLlmCalls=200
        const before = p.maxLlmCalls;
        grantBrakeExtension(p, p.startedAt + mins(121));
        expect(p.maxLlmCalls).toBe(before + p.extendLlmCalls);
    });

    it("★ 调用数加时**不许越过 hardLlmCalls**（那是跨不过去的绝对天花板，SOFT 涨 HARD 不动）", () => {
        const p = policyAt();
        const hard = p.hardLlmCalls;
        for (let i = 0; i < 10; i++) grantBrakeExtension(p, p.startedAt + mins(121 + i * 31));
        expect(p.maxLlmCalls).toBe(hard);           // 顶到天花板就停在那儿
        expect(p.hardLlmCalls).toBe(hard);          // 天花板自己一个字没动
    });

    it("★ CF_BRAKE_EXTEND_CALLS 可控；不配 = 默认值", () => {
        expect(resolveBrakePolicy({}).extendLlmCalls).toBe(DEFAULT_EXTEND_LLM_CALLS);
        expect(resolveBrakePolicy({ [ENV_EXTEND_LLM_CALLS]: "350" }).extendLlmCalls).toBe(350);
        // 垃圾/超大值都要被夹回合法区间（不许 NaN、不许越 MAX_LLM_CALLS_CAP）
        expect(resolveBrakePolicy({ [ENV_EXTEND_LLM_CALLS]: "abc" }).extendLlmCalls).toBe(DEFAULT_EXTEND_LLM_CALLS);
        expect(resolveBrakePolicy({ [ENV_EXTEND_LLM_CALLS]: "999999" }).extendLlmCalls).toBe(MAX_LLM_CALLS_CAP);
    });
});

describe("刹车·答案解析（人是最终裁决：继续 / 收口 / 停）", () => {
    it("空 / y / yes / 是 → extend（AUTO_CONFIRM=1 与「超时无人应答取选项 1」都走这条）", () => {
        for (const ans of ["", "  ", "y", "Y", "yes", "是", "ok", "好的"]) {
            const d = parseBrakeAnswer(ans);
            expect(d.action).toBe("extend");
            expect(d.guidance).toBeNull();
        }
    });

    it("三个选项序号：1 → 继续；2 → 按现状收口；3 → 立刻停止", () => {
        expect(parseBrakeAnswer("1").action).toBe("extend");
        expect(parseBrakeAnswer("2").action).toBe("finalize");
        expect(parseBrakeAnswer("3").action).toBe("stop");
        expect(parseBrakeAnswer("2)").action).toBe("finalize");
        expect(parseBrakeAnswer("3、").action).toBe("stop");
        expect(parseBrakeAnswer(" 1 ").action).toBe("extend");
    });

    it("中文关键词：继续/加时/延长 → extend；收口/收尾/交付 → finalize；停止/立刻停/别做了 → stop", () => {
        for (const t of ["继续", "加时", "延长", "再给 30 分钟", "接着干"]) {
            expect(parseBrakeAnswer(t).action).toBe("extend");
        }
        for (const t of ["按现状收口", "收尾吧", "先交付能跑的", "封版"]) {
            expect(parseBrakeAnswer(t).action).toBe("finalize");
        }
        for (const t of ["停止", "立刻停", "别做了", "不用了", "算了"]) {
            expect(parseBrakeAnswer(t).action).toBe("stop");
        }
    });

    it("★ 否定式优先：'别继续了' 必须是 stop，不能读成「继续」（方向反了比多问一次严重得多）", () => {
        expect(parseBrakeAnswer("别继续了").action).toBe("stop");
        expect(parseBrakeAnswer("不要继续加班").action).toBe("stop");
        expect(parseBrakeAnswer("先别继续").action).toBe("stop");
        expect(parseBrakeAnswer("别继续了，收口吧").action).toBe("stop");
    });

    it("自由文本 → 继续（当作人的指示），原话进 guidance 带上上下文", () => {
        const d = parseBrakeAnswer("先把登录页跑通再回来问我");
        expect(d.action).toBe("extend");
        expect(d.guidance).toBe("先把登录页跑通再回来问我");
        expect(d.note).toContain("自由指示");
    });
});

describe("刹车·组题（人拿到的是能决策的问题，不是一句超时了）", () => {
    const status = checkBrake(policyAt(), { callsCompleted: 147, elapsedMs: mins(121) });

    it("题面带**真数字**：墙钟/LLM 用量与天花板、工作项完成数、剩余项、工具调用、修复次数、验收绿数", () => {
        const q = brakeQuestion(status, summaryAt(), 1);
        expect(q.prompt).toContain("121.0 分钟/120.0 分钟");       // 已跑 vs SOFT
        expect(q.prompt).toContain("天花板 180 分钟");              // 无人值守天花板（时长口径）
        expect(q.prompt).toContain("147/400 调（天花板 800 调）");
        expect(q.prompt).toContain("工作项：3/5 完成");
        expect(q.prompt).toContain("剩余 2/5 个工作项（w4, w5）");
        expect(q.prompt).toContain("工具调用 61 次｜修复尝试 2 次｜验收判据：4/12 绿");
        expect(q.prompt).toContain("最近一次失败：ACCEPTANCE-3 期望 200 实得 500");
        // 题面必须交代"我会安静等你多久"与"你不答会怎样"（人才知道要不要回）
        expect(q.prompt).toContain("停手等你 30 分钟");
        expect(q.prompt).toContain("零模型调用、零写盘");
        expect(q.prompt).toContain("我就干净地退出进程");
    });

    it("★ 选项顺序即默认序：1) 继续（安全默认）2) 按现状收口 3) 立刻停止；分钟数跟随配置", () => {
        const q = brakeQuestion(status, summaryAt({ extendMinutes: 15 }), 1);
        expect(q.options).toEqual(brakeOptions(15));
        const opts = q.options ?? [];
        expect(opts.length).toBe(3);
        expect(opts[0]).toContain("继续");
        expect(opts[0]).toContain("加时 15 分钟");
        expect(opts[1]).toContain("按现状收口");
        expect(opts[1]).toContain("进展报告");
        expect(opts[2]).toContain("立刻停止");
        // 默认选项 = 选项 1 → 解析"y"/空必须落在"继续"上
        expect(parseBrakeAnswer("").action).toBe("extend");
    });

    it("★ 题号确定/幂等：brake-<taskId>-<n>（下次拉起来问同一道题，人已答就消费那个答案）", () => {
        expect(brakeQuestionId("t1", 1)).toBe("brake-t1-1");
        expect(brakeQuestion(status, summaryAt(), 1).questionId).toBe("brake-t1-1");
        expect(brakeQuestion(status, summaryAt(), 3).questionId).toBe("brake-t1-3");
    });

    it("账本里没有验收读数 → 诚实写「没有读数」，绝不编一个好看的数字", () => {
        const q = brakeQuestion(status, summaryAt({ checksGreen: null, checksTotal: null }), 1);
        expect(q.prompt).toContain("验收判据：账本里没有读数");
        expect(q.prompt).not.toContain("绿");
    });
});

describe("刹车·静默等待（askBrakeQuietly：零模型调用、零写盘地等）", () => {
    it("人答了 → 立刻拿到答案（不额外等待）", async () => {
        const asked: string[] = [];
        const q: BrakeQuestioner = { ask: async (req) => { asked.push(req.questionId); return "2"; } };
        const r = await askBrakeQuietly({ questionId: "brake-t1-1", prompt: "x" }, q, 60_000);
        expect(r.timedOut).toBe(false);
        expect(r.answer).toBe("2");
        expect(r.waitedMs).toBeLessThan(1_000);
        expect(asked).toEqual(["brake-t1-1"]);
    });

    it("★ 没人答 → 等满窗口后**安静地**超时（不是错误，是「人不在」）", async () => {
        // 问答器"一直在轮询"（永不 resolve）——模拟 Web 跑法里没人点气泡卡
        const q: BrakeQuestioner = { ask: () => new Promise<string>(() => { /* 永远等一下去 */ }) };
        const t0 = Date.now();
        const r = await askBrakeQuietly({ questionId: "brake-t1-1", prompt: "x" }, q, 120);
        expect(r.timedOut).toBe(true);
        expect(r.answer).toBeNull();
        expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
        expect(Date.now() - t0).toBeLessThan(3_000);      // 不许多等
    });

    it("问答器抛异常 → 如实抛给调用方（由它走「保状态退出」，那里会留痕并保留任务）", async () => {
        const q: BrakeQuestioner = { ask: async () => { throw new Error("Java 不可达（假件）"); } };
        await expect(askBrakeQuietly({ questionId: "brake-t1-1", prompt: "x" }, q, 60_000))
            .rejects.toThrow("Java 不可达");
    });
});

describe("刹车·进展报告（保状态退出/收口都要交的东西）", () => {
    const status = checkBrake(policyAt(), { callsCompleted: 147, elapsedMs: mins(121) });

    it("报告包含：做了什么 / 还差什么 / 为什么停 / 证据 / 消耗（每一段都带数字）", () => {
        const r = buildProgressReport(status, summaryAt(), "静默等满 30 分钟没人确认 → 保状态退出");
        expect(r.reason).toContain("[BRAKE:wall_clock]");
        expect(r.reason).toContain("保状态退出");
        expect(r.text).toContain("【已完成】工作项 3/5｜改动 7 个文件｜工具调用 61 次｜修复尝试 2 次｜验收 4/12 绿");
        expect(r.text).toContain("【还差什么】2/5 个工作项未完成：w4, w5");
        expect(r.text).toContain("【为什么停】ACCEPTANCE-3 期望 200 实得 500");
        expect(r.text).toContain("【证据】");
        expect(r.text).toContain("【消耗】墙钟 121.0 分钟/120.0 分钟（无人值守天花板 180 分钟）｜LLM 147/400 调");
        expect(r.payload["remainingWorkItems"]).toEqual(["w4", "w5"]);
        expect(r.payload["checksGreen"]).toBe(4);
        expect(r.payload["extensionsUsed"]).toBe(0);
    });

    it("工作项全做完但卡在验收 → 报告说「剩余风险在验收/收口环节」，不假装「还差工作项」", () => {
        const r = buildProgressReport(status, summaryAt({
            workItemsDone: 5, remaining: [], checksGreen: 11, checksTotal: 12,
        }), "等不到人");
        expect(r.text).toContain("工作项已全部完成（剩余风险在验收/收口环节）");
        expect(r.text).toContain("验收 11/12 绿");
    });

    it("报告有长度上限（error_msg 是库里的列，不许无限长）", () => {
        const r = buildProgressReport(status, summaryAt({ lastError: "x".repeat(5000) }), "y".repeat(5000));
        expect(r.reason.length).toBeLessThan(1600);
        expect(r.text.length).toBeLessThan(3200);
        expect(r.reason).toContain("截断");
    });
});

describe("刹车·账本读数（绿判据 / 最近失败：廉价读，不跑测试）", () => {
    it("取最近一条 acceptance_criteria_status 数绿；没有就 null（诚实交空）", () => {
        expect(acceptanceGreen([])).toBeNull();
        expect(acceptanceGreen([{ type: "llm_call_planned", payload: {} }])).toBeNull();
        expect(acceptanceGreen([
            { type: "acceptance_criteria_status", payload: { status: { a: "pass", b: "fail" } } },
            { type: "acceptance_criteria_status", payload: { status: { a: "pass", b: "pass", c: "unevaluable" } } },
        ])).toEqual({ green: 2, total: 3 });
        expect(acceptanceGreen([{ type: "acceptance_criteria_status", payload: { status: {} } }])).toBeNull();
    });

    it("取最近一次失败原因；没有就 null", () => {
        expect(lastFailureReason([])).toBeNull();
        expect(lastFailureReason([{ type: "test_failure", payload: { reason: "ACCEPTANCE-2 500" } }]))
            .toBe("ACCEPTANCE-2 500");
        expect(lastFailureReason([
            { type: "test_failure", payload: { reason: "旧的" } },
            { type: "blocked_unverified", payload: { reason: "新的" } },
        ])).toBe("新的");
    });
});

describe("刹车·可观测性（账本事件名 / 到点文本 / 一行日志）", () => {
    it("事件名固定：eval 报告与对账器 grep 这两个字面量", () => {
        expect(brakeEventName("wall_clock")).toBe("wall_clock_exceeded");
        expect(brakeEventName("llm_budget")).toBe("llm_budget_exceeded");
    });

    it("到点文本带 [BRAKE:...] 前缀 + 消耗量（人问为什么停时看的就是它，不许含糊）", () => {
        const wall = brakeReasonText(checkBrake(policyAt(), { callsCompleted: 213, elapsedMs: mins(120) + 600 }));
        expect(wall).toContain("[BRAKE:wall_clock]");
        expect(wall).toContain("已跑 120.0 分钟/120.0 分钟");
        expect(wall).toContain("213/400 调");
        const budget = brakeReasonText(checkBrake(policyAt(), { callsCompleted: 400, elapsedMs: mins(10) }));
        expect(budget).toContain("[BRAKE:llm_budget]");
        expect(budget).toContain("400/400 调");
        expect(brakeReasonText(checkBrake(policyAt(), { callsCompleted: 0, elapsedMs: 0 }))).toBe("");
    });

    it("到点原因短名", () => {
        expect(brakeReasonLabel("wall_clock")).toBe("墙钟");
        expect(brakeReasonLabel("llm_budget")).toBe("调用数");
    });

    it("一行日志说清谁到点 + 烧了多少 + 还剩什么没做，无人值守天花板单独标注", () => {
        const s = checkBrake(policyAt(), { callsCompleted: 213, elapsedMs: mins(120) });
        const line = brakeLogLine(s, {
            changedFiles: 7, workItemsTotal: 5, workItemsDone: 3, remaining: ["w4", "w5"],
        });
        expect(line).toContain("wall_clock");
        expect(line).toContain("跑了 120.0 分钟/120.0 分钟");
        expect(line).toContain("已改 7 个文件");
        expect(line).toContain("未完成 2/5 个工作项（w4, w5）");
        expect(line).not.toContain("天花板");     // Web 跑法：这一行只说"到点，该问人"
        const done = brakeLogLine(s, { changedFiles: 9, workItemsTotal: 5, workItemsDone: 5, remaining: [] });
        expect(done).toContain("工作项已全部完成");
        const capped = brakeLogLine(
            checkBrake(policyAt({ unattended: true }), { callsCompleted: 213, elapsedMs: mins(181) }),
            { changedFiles: 7, workItemsTotal: 5, workItemsDone: 3, remaining: ["w4", "w5"] });
        expect(capped).toContain("无人值守天花板");
        expect(brakeLogLine(checkBrake(policyAt(), { callsCompleted: 0, elapsedMs: 0 }), {
            changedFiles: 0, workItemsTotal: 0, workItemsDone: 0, remaining: [],
        })).toBe("");
    });

    it("formatElapsed / formatMinutes 是唯一的口径（前者带一位小数、后者是整分钟）", () => {
        expect(formatElapsed(0)).toBe("0.0 分钟");
        expect(formatElapsed(90_000)).toBe("1.5 分钟");
        expect(formatElapsed(-1)).toBe("0.0 分钟");
        expect(formatMinutes(mins(180))).toBe("180 分钟");
        expect(formatMinutes(-1)).toBe("0 分钟");
    });
});
