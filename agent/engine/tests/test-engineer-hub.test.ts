// ============================================================
// tests/test-engineer-hub.test.ts —— test-core 新线（9/15 改线）零 LLM 联调测试
//
//   验证面 = testEngineer.TestEngineer 的 Hub 收发 + 三道自我校验：
//     · 假站点 = 真 TransferStation（纯内存消息总线，本身就是零外部依赖的 fake station）；
//     · 假 verifier = deps.verifier 注入缝（真实现会 spawn 外部 testAgent，测试里绝不进那条路）；
//     · 出站结果逐字过 developer 端 parseInbound——形状不对当场红。
//   钉死的行为：passed/failure 正常回带；hash 不符拒发；超 deadline 拒发（含
//   「到达即超窗」与「回来才超窗」两处）；非 developer 发的 test_request 不理；
//   重复轮票幂等；verifier 回错包/不过 schema 拒发；unverified 走编排通知不冒充结果。
// ============================================================

import { describe, expect, test } from "bun:test";
import { TransferStation, roles, type Message } from "../Hub";
import {
    TestEngineer, TEST_CORE_NAME,
    type TestEngineerDeps, type VerifyRoundRequest,
} from "../testEngineer";
import { acceptanceHashOf, parseInbound } from "../developerAgent/protocol";
import type {
    AdditionalFailure, MechanicalEvidence, TestFailure, TestPassed, VerificationEvidence,
} from "../developerAgent/protocol";
import { DEVELOPER_NAME } from "../developerAgent/hubAdapter";
import type { AdapterVerifyResult, VerifyAdapterOutcome } from "../testAgentAdapter";

const ORCH = "v2-orchestrator";

/** 任务包里的原始判据（developer 端 acceptanceHashOf 的同一份内容 → hash 自检同源） */
const TASK_CHECKS = [
    { id: "c1", kind: "COMPILE", target: "backend" },
    { id: "c2", kind: "CONTRACT", method: "GET", path: "/api/health", expectedStatus: 200 },
];
const HASH = acceptanceHashOf(TASK_CHECKS);

function baseRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "test_request",
        projectId: "p7", taskId: "p7-t1",
        correlationId: "corr-1", acceptanceHash: HASH,
        deadlineAt: Date.now() + 600_000,
        targets: ["frontend", "backend"],
        reason: "本地检查通过，请求正式验证",
        ...over,
    };
}

interface Harness {
    station: TransferStation;
    logs: string[];
    verifyCalls: () => number;
}

/** 假站点（真 TransferStation，纯内存）+ 假 verifier（注入缝）装配一个 test-core */
function makeAgent(
    verify: (r: VerifyRoundRequest) => VerifyAdapterOutcome | Promise<VerifyAdapterOutcome>,
    deps: Partial<TestEngineerDeps> = {},
): Harness {
    const station = new TransferStation({}, {});
    station.register(DEVELOPER_NAME, roles.unknown);   // developer 收件箱（本测试只看不消费）
    const logs: string[] = [];
    let calls = 0;
    const agent = new TestEngineer(TEST_CORE_NAME, station, [], {
        taskChecks: () => TASK_CHECKS,
        log: (l) => { logs.push(l); },
        ...deps,
        verifier: async (r) => { calls++; return verify(r); },
    });
    void agent.start();   // 后台消息循环；断言全部走 waitFor 轮询，不赌时序
    return { station, logs, verifyCalls: () => calls };
}

function inboxOf(station: TransferStation, name: string): Message[] {
    return station.teams[name]?.inbox ?? [];
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > timeoutMs) return false;
        await Bun.sleep(5);
    }
    return true;
}

/** 等某条留痕出现（负向用例的确定性锚点：等完即可断言"没发出去"） */
async function waitLog(h: Harness, needle: string): Promise<void> {
    expect(await waitFor(() => h.logs.some((l) => l.includes(needle)))).toBe(true);
    await Bun.sleep(20); // 留痕之后若还有发送动作，让它落地再断言 inbox
}

// ---------- 假 verifier 的产物工厂（形状照 protocol，字段自己填齐） ----------

function passedMessage(r: VerifyRoundRequest): TestPassed {
    const now = Date.now();
    const evidence: VerificationEvidence[] = [{
        checkId: "c1", command: "bun", args: ["run", "build"], cwd: ".",
        exitCode: 0, startedAt: now - 1000, finishedAt: now,
        inputHash: "in-h", stdoutHash: "out-h", stderrHash: "err-h",
    }];
    return {
        type: "test_passed", messageId: "msg-pass-1",
        correlationId: r.correlationId, projectId: r.projectId, taskId: r.taskId, runId: r.runId,
        evidence, verifiedBy: "testagent-verify", acceptanceHash: r.acceptanceHash,
    };
}

function failureMessage(r: VerifyRoundRequest): TestFailure {
    const now = Date.now();
    const allFailures: AdditionalFailure[] = [
        { checkId: "c1", category: "COMPILE", command: "bun", args: ["tsc"], cwd: ".", exitCode: 2,
          stdout: "", stderr: "error TS2322: x", failureSignature: "sig-c1", startedAt: now - 500, finishedAt: now, durationMs: 500 },
        { checkId: "c2", category: "CONTRACT", command: "bun", args: ["probe"], cwd: ".", exitCode: null,
          stdout: "", stderr: "boot timeout", failureSignature: "sig-c2", timedOut: true },
    ];
    const mechanicalEvidence: MechanicalEvidence[] = allFailures.map((f) => ({
        checkId: f.checkId, category: f.category, command: f.command, args: f.args, cwd: f.cwd,
        exitCode: f.exitCode, timedOut: f.timedOut === true,
        startedAt: now - 500, finishedAt: now, durationMs: 500,
        stdout: f.stdout, stderr: f.stderr, failureSignature: f.failureSignature,
    }));
    return {
        type: "test_failure", messageId: "msg-fail-1",
        correlationId: r.correlationId, runId: r.runId, acceptanceHash: r.acceptanceHash,
        projectId: r.projectId, taskId: r.taskId,
        category: "COMPILE", command: "bun", args: ["tsc"], cwd: ".", exitCode: 2,
        stdout: "", stderr: "error TS2322: x", affectedFiles: ["src/a.ts"],
        failureSignature: "sig-c1", allFailures, mechanicalEvidence,
        origin: "mechanical", needsHuman: false,
    };
}

function fakeResult(r: VerifyRoundRequest, over: Partial<AdapterVerifyResult> = {}): AdapterVerifyResult {
    return {
        verdict: "pass", projectId: r.projectId, taskId: r.taskId, runId: r.runId,
        correlationId: r.correlationId, acceptanceHash: r.acceptanceHash,
        evidence: [], skipped: [], failure: null, ...over,
    };
}

// ============================================================

describe("test-core（新线）：test_request → 注入 verifier → test_passed/test_failure 回 developer", () => {

    test("通过轮：test_passed 原样回带身份并逐字过 developer 的 parseInbound", async () => {
        const h = makeAgent((r) => ({ kind: "test_passed", message: passedMessage(r), result: fakeResult(r) }));
        h.station.sendMessage(DEVELOPER_NAME, TEST_CORE_NAME, JSON.stringify(baseRequest()));
        expect(await waitFor(() => inboxOf(h.station, DEVELOPER_NAME).length === 1)).toBe(true);

        const env = inboxOf(h.station, DEVELOPER_NAME)[0]!;
        expect(env.sender).toBe(TEST_CORE_NAME);            // 信任链实名 = 注册名 test-core
        expect(env.receiver).toBe(DEVELOPER_NAME);
        const parsed = parseInbound(env.content);
        if (!parsed.ok) throw new Error(`test_passed 没过 developer 契约：${parsed.error}`);
        const m = parsed.message as TestPassed;
        expect(m.type).toBe("test_passed");
        expect(m.correlationId).toBe("corr-1");
        expect(m.acceptanceHash).toBe(HASH);
        expect(m.projectId).toBe("p7");
        expect(m.taskId).toBe("p7-t1");
        expect(m.runId).toBe("p7-t1");                      // 缺省 runId = taskId（与 hub-runner 现行默认一致）
        expect(m.messageId).toBe("msg-pass-1");
        expect(m.verifiedBy).toBe(TEST_CORE_NAME);          // 出站前改写为本机注册名
        expect(m.evidence).toHaveLength(1);
        expect(m.evidence[0]!.exitCode).toBe(0);
        expect(h.verifyCalls()).toBe(1);
    });

    test("失败轮：test_failure 带全逐判据证据（allFailures/mechanicalEvidence）且过 parseInbound", async () => {
        const h = makeAgent((r) => ({
            kind: "test_failure", message: failureMessage(r), result: fakeResult(r), reasons: ["c1 编译红"],
        }));
        h.station.sendMessage(DEVELOPER_NAME, TEST_CORE_NAME, JSON.stringify(baseRequest()));
        expect(await waitFor(() => inboxOf(h.station, DEVELOPER_NAME).length === 1)).toBe(true);

        const parsed = parseInbound(inboxOf(h.station, DEVELOPER_NAME)[0]!.content);
        if (!parsed.ok) throw new Error(`test_failure 没过 developer 契约：${parsed.error}`);
        const m = parsed.message as TestFailure;
        expect(m.type).toBe("test_failure");
        expect(m.correlationId).toBe("corr-1");
        expect(m.acceptanceHash).toBe(HASH);
        expect(m.category).toBe("COMPILE");
        expect(m.exitCode).toBe(2);
        expect(m.failureSignature).toBe("sig-c1");
        expect(m.allFailures).toHaveLength(2);              // 红单全量，不逐条挤牙膏
        expect(m.allFailures![1]!.timedOut).toBe(true);     // 超时线索原样带走
        expect(m.mechanicalEvidence).toHaveLength(2);
    });

    test("hash 不符拒发：请求 acceptanceHash ≠ 本地任务包算出的 → 不烧 verify 不发结果", async () => {
        const h = makeAgent((r) => ({ kind: "test_passed", message: passedMessage(r), result: fakeResult(r) }));
        h.station.sendMessage(DEVELOPER_NAME, TEST_CORE_NAME, JSON.stringify(baseRequest({ acceptanceHash: "hash-别的轮次" })));
        await waitLog(h, "acceptanceHash 不符");
        expect(h.verifyCalls()).toBe(0);
        expect(inboxOf(h.station, DEVELOPER_NAME)).toHaveLength(0);
    });

    test("到达即超窗拒发：deadlineAt 已过 → 主动放弃并留痕（连 verify 都不烧）", async () => {
        const h = makeAgent(
            (r) => ({ kind: "test_passed", message: passedMessage(r), result: fakeResult(r) }),
            { now: () => 2_000 },
        );
        h.station.sendMessage(DEVELOPER_NAME, TEST_CORE_NAME, JSON.stringify(baseRequest({ deadlineAt: 1_000 })));
        await waitLog(h, "到达即超窗");
        expect(h.verifyCalls()).toBe(0);
        expect(inboxOf(h.station, DEVELOPER_NAME)).toHaveLength(0);
    });

    test("回来才超窗拒发：verify 执行期间越过 deadlineAt → 弃发留痕（developer 对迟到结果一律拒）", async () => {
        let ticks = 0;
        const h = makeAgent(
            (r) => ({ kind: "test_passed", message: passedMessage(r), result: fakeResult(r) }),
            { now: () => (++ticks === 1 ? 4_000 : 6_000) }, // 进闸在窗内，回来看已超窗
        );
        h.station.sendMessage(DEVELOPER_NAME, TEST_CORE_NAME, JSON.stringify(baseRequest({ deadlineAt: 5_000 })));
        await waitLog(h, "回来时已超窗");
        expect(h.verifyCalls()).toBe(1);                    // 验了，但结果被弃
        expect(inboxOf(h.station, DEVELOPER_NAME)).toHaveLength(0);
    });

    test("非 developer 发的 test_request 不理（伪造送检不进验收面）", async () => {
        const h = makeAgent((r) => ({ kind: "test_passed", message: passedMessage(r), result: fakeResult(r) }));
        h.station.sendMessage("merger", TEST_CORE_NAME, JSON.stringify(baseRequest()));
        expect(await waitFor(() => (h.station.status[TEST_CORE_NAME]?.totalProcessed ?? 0) >= 1)).toBe(true);
        await Bun.sleep(20);
        expect(h.verifyCalls()).toBe(0);
        expect(inboxOf(h.station, DEVELOPER_NAME)).toHaveLength(0);
    });

    test("重复 correlationId 幂等：同轮票重投只验一次、只发一条", async () => {
        const h = makeAgent((r) => ({ kind: "test_passed", message: passedMessage(r), result: fakeResult(r) }));
        const req = JSON.stringify(baseRequest());
        h.station.sendMessage(DEVELOPER_NAME, TEST_CORE_NAME, req);
        expect(await waitFor(() => inboxOf(h.station, DEVELOPER_NAME).length === 1)).toBe(true);
        h.station.sendMessage(DEVELOPER_NAME, TEST_CORE_NAME, req);   // Hub 重投
        await waitLog(h, "幂等忽略");
        expect(h.verifyCalls()).toBe(1);
        expect(inboxOf(h.station, DEVELOPER_NAME)).toHaveLength(1);
    });

    test("verifier 回错包拒发：correlationId 是别的轮的 → 原样回带核对不过", async () => {
        const h = makeAgent((r) => {
            const m = passedMessage(r);
            return { kind: "test_passed", message: { ...m, correlationId: "corr-陈年旧轮" }, result: fakeResult(r) };
        });
        h.station.sendMessage(DEVELOPER_NAME, TEST_CORE_NAME, JSON.stringify(baseRequest()));
        await waitLog(h, "回错包");
        expect(inboxOf(h.station, DEVELOPER_NAME)).toHaveLength(0);
    });

    test("结果不过 developer schema 拒发：自称 pass 但 evidence 为空发不出机器", async () => {
        const h = makeAgent((r) => {
            const m = passedMessage(r);
            return { kind: "test_passed", message: { ...m, evidence: [] }, result: fakeResult(r) };
        });
        h.station.sendMessage(DEVELOPER_NAME, TEST_CORE_NAME, JSON.stringify(baseRequest()));
        await waitLog(h, "不过 developer 契约 schema");
        expect(inboxOf(h.station, DEVELOPER_NAME)).toHaveLength(0);
    });

    test("unverified 不冒充结果：不给 developer 发，配了 orchestrator 则按 v2_verdict 通知", async () => {
        const h = makeAgent(
            (r) => ({
                kind: "unverified",
                result: fakeResult(r, {
                    verdict: "blocked_unverified",
                    skipped: [{ checkId: "c2", reason: "无工程构建入口，未执行" }],
                }),
            }),
            { orchestrator: ORCH },
        );
        h.station.sendMessage(DEVELOPER_NAME, TEST_CORE_NAME, JSON.stringify(baseRequest()));
        expect(await waitFor(() => inboxOf(h.station, ORCH).length === 1)).toBe(true);
        const v = JSON.parse(inboxOf(h.station, ORCH)[0]!.content) as Record<string, unknown>;
        expect(v.type).toBe("v2_verdict");
        expect(v.kind).toBe("unverified");
        expect(v.correlationId).toBe("corr-1");
        expect((v.skipped as unknown[]).length).toBe(1);
        expect(inboxOf(h.station, DEVELOPER_NAME)).toHaveLength(0);
    });
});
