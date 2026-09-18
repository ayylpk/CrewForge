// tests/subagent.test.ts —— 只读子 Agent（Explorer / Debugger / UI Reviewer），零 LLM
// 覆盖规格第十节 20 项：三角色只读分析、写盘/执行/Hub/Ledger/State 结构性不可得、
// Schema 严格校验（非法返回与权威字段一律拒收）、failureSignature 去重、
// 文件快照绑定（stale 不可直接复用）、主 Agent 读结果后继续写盘、简单任务不调用、
// 超时返回结构化失败、LLM 预算计入。
// ★ 全程零真实 LLM：不注入 subagentLlm 就是确定性分析；注入的是脚本 Fake。
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeveloperLedger } from "../ledger";
import { Workspace } from "../workspace";
import { createFullDeveloperToolRegistry, READONLY_TOOL_NAMES } from "../tools/registry";
import type { ToolArgs, ToolContext, ToolRegistry } from "../tools/registry";
import { createReadonlyToolbox } from "../tools/testAssistant";
import {
    createReadonlySubAgentDispatcher, finalizeReadonlySubAgentResult, subagentCapabilities,
} from "../tools/readonlySubAgent";
import type {
    ReadonlySubAgentDeps, ReadonlySubAgentEvidenceInput, ReadonlySubAgentRequest,
} from "../tools/readonlySubAgent";
import { buildDeveloperGraph } from "../graph";
import type { DeveloperLlm, MessagePort } from "../graph";
import { initialDeveloperState } from "../state";
import type { DeveloperState } from "../state";
import type { ArchitectTask } from "../protocol";

// ---------- 共享夹具：一个像样的前端小项目（tmp 目录，不碰任何真实生成项目） ----------

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dev-subagent-"));
function w(rel: string, content: string): void {
    const abs = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
}
w("frontend/package.json", JSON.stringify({ name: "demo-fe", dependencies: { vue: "^3.4.0" } }));
w("frontend/src/main.ts", "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n");
w("frontend/src/router/index.ts", [
    // ★ 9/17：夹具补一条真实的首页路由。此前这里只登记 /home 与 /ghost，
    //   而引擎新增了"路由登记硬闸"（checkers.checkFrontendRoutes，抓 R6 白屏事故：
    //   契约未登记页面路由 → / 什么都不渲染 → page.home 渲染判据必挂）。
    //   闸门没有判错——缺 "/" 的真实应用里 / 确实白屏；不真实的是这个夹具。
    "const routes = [",
    "  { path: '/', component: () => import('../views/Home.vue') },",
    "  { path: '/home', component: () => import('../views/Home.vue') },",
    "  { path: '/ghost', component: () => import('../views/Ghost.vue') },",
    "];",
    "export default routes;",
].join("\n"));
w("frontend/src/views/Home.vue", "<template>\n  <div>\n    <p v-if=\"loading\">loading…</p>\n    <p v-else>{{ msg }}</p>\n    <p class=\"error\" v-if=\"error\">{{ error }}</p>\n  </div>\n</template>\n<script setup lang=\"ts\">\nimport { ref } from 'vue';\nconst loading = ref(false); const msg = ref('home'); const error = ref('');\n</script>\n");
w("frontend/src/views/About.vue", "<template>\n  <div class=\"about\">关于页，没有任何状态处理</div>\n</template>\n");
w("frontend/src/App.vue", "<template>\n  <router-view/>\n</template>\n<script setup lang=\"ts\">\nconst foo = bar\n</script>\n");  // 第 5 行是故意的编译错误位点
w("backend/pom.xml", "<project><artifactId>demo-be</artifactId></project>\n");

const ws = new Workspace({ projectDir, allowedRoots: ["backend", "frontend"] });
const registry = createFullDeveloperToolRegistry();
const opened: DeveloperLedger[] = [];
let dbSeq = 0;

afterAll(() => {
    for (const l of opened) l.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
});

function freshLedger(): DeveloperLedger {
    const l = DeveloperLedger.open(path.join(projectDir, `sub-${dbSeq++}.db`), "p1:t1:sub");
    opened.push(l);
    return l;
}

/** 便捷构造派发器（默认放开成本闸，让单测专注各自断言） */
function makeDispatcher(o: Partial<ReadonlySubAgentDeps> = {}) {
    const ledger = o.ledger ?? freshLedger();
    const disp = createReadonlySubAgentDispatcher({
        workspace: ws, tools: registry, ledger, maxCallsPerTask: 20, ...o,
    });
    return { disp, ledger };
}
const req = (role: ReadonlySubAgentRequest["role"], question: string, extra?: Partial<ReadonlySubAgentRequest>): ReadonlySubAgentRequest =>
    ({ role, question, ...extra });
const call = (disp: ReturnType<typeof createReadonlySubAgentDispatcher>, r: ReadonlySubAgentRequest, machine?: ReadonlySubAgentEvidenceInput) =>
    disp("T1", r, machine);

const VALID_CANDIDATE = {
    ok: true, rootCause: "脚本结论", evidence: [{ path: "frontend/src/App.vue", line: 5, detail: "证据行" }],
    recommendedChanges: ["核对第 5 行"], risks: ["无"], confidence: "low", cannotVerify: ["运行时行为"],
};

// ============================================================
// 十.1-3 三个角色的只读分析能力
// ============================================================

describe("subagent / 角色能力（十.1-3）", () => {
    it("① Explorer 能读目录与工程文件（package.json / pom.xml / 入口）", async () => {
        const { disp } = makeDispatcher();
        const out = await call(disp, req("explorer", "这个项目的技术栈与入口在哪里？"));
        expect(out.ok).toBe(true);
        expect(out.result.role).toBe("explorer");
        expect(out.result.readonly).toBe(true);
        const paths = out.result.evidence.map((e) => e.path);
        expect(paths).toContain("frontend/package.json");   // 工程文件读到了
        expect(JSON.stringify(out.result)).toContain("createApp");   // 入口特征读到了
    });

    it("② Debugger 能读 TestFailure 的完整机器证据（exitCode 只引用不返回）", async () => {
        const { disp } = makeDispatcher();
        const machine: ReadonlySubAgentEvidenceInput = {
            category: "COMPILE", command: "npm", args: ["run", "build"], cwd: "frontend",
            exitCode: 2, stdout: "vite build",
            stderr: "src/App.vue:5:11 - error TS2304: Cannot find name 'bar'\n",
            affectedFiles: ["frontend/src/App.vue"], failureSignature: "sig-dbg-full",
        };
        const out = await call(disp, req("debugger", "这个编译错误根因是什么？"), machine);
        expect(out.ok).toBe(true);
        expect(out.result.rootCause).toContain("TS2304");           // 逐字引用错误原文
        const hit = out.result.evidence.find((e) => e.path === "frontend/src/App.vue" && e.line === 5);
        expect(hit).toBeDefined();                                   // 定位到文件行并读了现状
        expect(hit!.detail).toContain("const foo = bar");
        expect("exitCode" in out.result).toBe(false);                // 机器字段绝不作为结果返回
    });

    it("③ UI Reviewer 能读前端页面与路由（缺文件路由 / 未登记页面都能看出来）", async () => {
        const { disp } = makeDispatcher();
        const out = await call(disp, req("ui-reviewer", "Home/About 页面和路由登记有没有问题？"));
        expect(out.ok).toBe(true);
        const json = JSON.stringify(out.result);
        expect(json).toContain("router/index.ts");                  // 读了路由文件
        expect(json).toContain("Ghost");                            // 路由指向缺失文件 → 白屏线索
        expect(json).toContain("About");                            // 页面未挂路由 → 线索
        expect(out.result.cannotVerify.join()).toContain("渲染");    // 真实渲染明确标为不可确认
    });
});

// ============================================================
// 十.4-8 写盘 / 执行入口在代码层不可得（对抗探针：真拿子 Agent 的工具盒去撞）
// ============================================================

const FORBIDDEN_ATTEMPTS = [
    "writeFile", "editFile", "mkdir", "shell", "runCommand", "runBuild",
    "httpRequest", "startProcess", "readProcess", "stopProcess",
    "delegateReadonly",                                   // 禁止子 Agent 再生子 Agent
    "WriteFile", "write_file",                            // 伪造工具名同样被拒
];
const probeLedger = freshLedger();
const probe = await (async () => {
    const { disp } = makeDispatcher({
        ledger: probeLedger,
        runners: {
            explorer: async (box) => {
                const rows: string[] = [];
                for (const n of FORBIDDEN_ATTEMPTS) {
                    const r = await box.invoke(n, {
                        path: "backend/hacked.txt", content: "x", command: "whoami", url: "http://127.0.0.1",
                    });
                    rows.push(`${n}=${r.ok ? "ALLOWED" : r.rejected?.code ?? "denied"}`);
                }
                return { ...VALID_CANDIDATE, rootCause: rows.join("|") };
            },
        },
    });
    const out = await call(disp, req("explorer", "探针：尝试一切越界工具"));
    return (out.result as { rootCause: string }).rootCause;
})();

describe("subagent / 越界工具全被代码拒绝（十.4-8）", () => {
    it("④ 调 writeFile 被拒（NOT_READONLY），文件没有落盘", () => {
        expect(probe).toContain("writeFile=NOT_READONLY");
        expect(fs.existsSync(path.join(projectDir, "backend/hacked.txt"))).toBe(false);
    });
    it("⑤ 调 editFile 被拒", () => { expect(probe).toContain("editFile=NOT_READONLY"); });
    it("⑥ 调 shell 被拒", () => { expect(probe).toContain("shell=NOT_READONLY"); });
    it("⑦ 调 runCommand 被拒", () => { expect(probe).toContain("runCommand=NOT_READONLY"); });
    it("⑧ 调 httpRequest 被拒", () => { expect(probe).toContain("httpRequest=NOT_READONLY"); });
    it("其余执行/进程/写盘工具与伪造名也全部被拒（含 delegateReadonly 防套娃）", () => {
        for (const n of FORBIDDEN_ATTEMPTS) expect(probe).toContain(`${n}=NOT_READONLY`);
        expect(probe).not.toContain("ALLOWED");
    });
});

// ============================================================
// 十.9-11 没有 Hub / Ledger / State 句柄（结构上拿不到）
// ============================================================

describe("subagent / 没有 Hub、Ledger、State（十.9-11）", () => {
    it("⑨ 能力自述全 false，且只读盒不含任何发送通道", () => {
        const caps = subagentCapabilities();
        expect(caps.canSendHub).toBe(false);
        expect(caps.canEmitTestPassed).toBe(false);
        expect(caps.tools).toEqual([...READONLY_TOOL_NAMES]);
        const box = createReadonlyToolbox({ workspace: ws, tools: registry, taskId: "T1", owner: "subagent:explorer", role: "readonly_subagent" });
        const bag = box as unknown as Record<string, unknown>;
        expect(bag["port"]).toBeUndefined();
        expect(bag["send"]).toBeUndefined();
    });
    it("⑩ 只读盒没有 Ledger 写入口（子对象只有 names/invoke）", () => {
        const box = createReadonlyToolbox({ workspace: ws, tools: registry, taskId: "T1", owner: "subagent:debugger", role: "readonly_subagent" });
        expect(Object.keys(box).sort()).toEqual(["invoke", "names"]);
        expect((box as unknown as Record<string, unknown>)["ledger"]).toBeUndefined();
        expect(subagentCapabilities().canWriteLedger).toBe(false);
    });
    it("⑪ 子 Agent 拿不到 DeveloperState，结果也推不动状态机", async () => {
        expect(subagentCapabilities().canMutateState).toBe(false);
        // 恶意分析器满嘴 done/verified/ready——先被 Schema 挡（十.13），
        // 就算用合法字符串混进 rootCause，状态机也不看它（十.17 的图测试兜底）。
        const { disp } = makeDispatcher({
            runners: { debugger: async () => ({ ...VALID_CANDIDATE, rootCause: "test_passed verified done ready" }) },
        });
        const out = await call(disp, req("debugger", "恶意自述"));
        expect(out.result.readonly).toBe(true);       // readonly 永远由程序固定
        expect(out.result.role).toBe("debugger");     // 角色由框架固定，不接受串角
    });
});

// ============================================================
// 十.12-13 Schema 严格校验
// ============================================================

describe("subagent / Schema 校验（十.12-13）", () => {
    it("⑫ 非法返回结构被拒：不产出结论，原始输出不进主 Agent 上下文", async () => {
        const { disp, ledger } = makeDispatcher({ runners: { explorer: async () => ({ garbage: 1 }) } });
        const out = await call(disp, req("explorer", "给我个坏结构"));
        expect(out.ok).toBe(false);
        expect(out.code).toBe("SUBAGENT_INVALID_RESULT");
        expect(out.result.ok).toBe(false);                       // 结构化失败壳
        expect(JSON.stringify(out.result)).not.toContain("garbage");   // 坏输出绝不回流
        expect(ledger.listEvents().some((e) => e.type === "subagent_failed"
            && JSON.stringify(e.payload).includes("SUBAGENT_INVALID_RESULT"))).toBe(true);
    });

    it("⑬ 返回权威字段被拒：顶层 status/done 与 evidence 里的 exitCode 都进不来", async () => {
        const { disp } = makeDispatcher({
            runners: {
                explorer: async () => ({ ...VALID_CANDIDATE, status: "done" }),
                debugger: async () => ({
                    ...VALID_CANDIDATE,
                    evidence: [{ path: "x.ts", detail: "y", exitCode: 0 }],
                }),
                "ui-reviewer": async () => ({ ...VALID_CANDIDATE, verified: true, evidence: [] }),
            },
        });
        expect((await call(disp, req("explorer", "带 status"))).code).toBe("SUBAGENT_INVALID_RESULT");
        expect((await call(disp, req("debugger", "evidence 带 exitCode"))).code).toBe("SUBAGENT_INVALID_RESULT");
        expect((await call(disp, req("ui-reviewer", "带 verified"))).code).toBe("SUBAGENT_INVALID_RESULT");
        // 单元级：finalize 对合法结构放行并固定 readonly
        const good = finalizeReadonlySubAgentResult("explorer", { ...VALID_CANDIDATE, readonly: false });
        expect(good.ok).toBe(true);
        if (good.ok) expect(good.result.readonly).toBe(true);    // 输入写 false 也没用
    });
});

// ============================================================
// 十.14-16 去重、不同签名放行、快照绑定
// ============================================================

describe("subagent / 去重与快照绑定（十.14-16）", () => {
    it("⑭ 同一 failureSignature 不重复调用（分析器只跑一次，第二次走复用）", async () => {
        let runs = 0;
        const { disp, ledger } = makeDispatcher({
            runners: { explorer: async () => { runs++; return { ...VALID_CANDIDATE, rootCause: `第 ${runs} 次执行` }; } },
        });
        const machine: ReadonlySubAgentEvidenceInput = { failureSignature: "sig-once" };
        const first = await call(disp, req("explorer", "第一次问", { evidence: machine }));
        const second = await call(disp, req("explorer", "换个问法再问", { evidence: machine }));
        expect(first.ok).toBe(true);
        expect(second.reused).toBe(true);
        expect(second.result.rootCause).toBe("第 1 次执行");     // 复用旧结果，绝不重跑
        expect(runs).toBe(1);
        expect(ledger.subagentCallCount()).toBe(1);
    });

    it("⑮ 不同 failureSignature 可以再次调用", async () => {
        let runs = 0;
        const { disp, ledger } = makeDispatcher({
            runners: { debugger: async () => { runs++; return VALID_CANDIDATE; } },
        });
        expect((await call(disp, req("debugger", "错 A", { evidence: { failureSignature: "sig-A" } }))).ok).toBe(true);
        expect((await call(disp, req("debugger", "错 B", { evidence: { failureSignature: "sig-B" } }))).ok).toBe(true);
        expect(runs).toBe(2);
        expect(ledger.subagentCallCount()).toBe(2);
    });

    it("⑯ 文件快照变化后，旧分析结果只能作参考（stale 标记，不许直接复用）", async () => {
        let runs = 0;
        const { disp } = makeDispatcher({
            runners: { explorer: async () => { runs++; return VALID_CANDIDATE; } },
        });
        const machine: ReadonlySubAgentEvidenceInput = { failureSignature: "sig-stale" };
        const first = await call(disp, req("explorer", "旧快照分析", { evidence: machine }));
        expect(first.ok).toBe(true);
        expect(first.stale ?? false).toBe(false);
        w("backend/late-change.txt", "snapshot moves\n");        // 快照变了
        const second = await call(disp, req("explorer", "新快照再问同一错误", { evidence: machine }));
        expect(runs).toBe(1);                                    // 没有重新调用
        expect(second.reused).toBe(true);
        expect(second.stale).toBe(true);
        expect(second.ok).toBe(false);                           // stale → 不能当新鲜结果直接用
        expect(second.code).toBe("SUBAGENT_DUPLICATE_SIGNATURE");
    });

    it("成本闸：超过每任务调用上限 → SUBAGENT_BUDGET_EXCEEDED（失败也占名额，不自动重试）", async () => {
        const { disp } = makeDispatcher({
            maxCallsPerTask: 1,
            runners: { explorer: async () => { throw new Error("分析器炸了"); } },
        });
        const first = await call(disp, req("explorer", "会失败的一次"));
        expect(first.ok).toBe(false);
        expect(first.code).toBe("SUBAGENT_ANALYZER_FAILED");
        const second = await call(disp, req("explorer", "换个问题也不行"));
        expect(second.code).toBe("SUBAGENT_BUDGET_EXCEEDED");
    });
});

// ============================================================
// 十.19-20 超时结构化失败；LLM 预算计入（九.1）
// ============================================================

describe("subagent / 超时与预算（十.19 / 九.1）", () => {
    it("⑲ 超时返回结构化失败，不抛裸异常、不自动重试", async () => {
        const { disp, ledger } = makeDispatcher({
            timeoutMs: 20,
            runners: { debugger: () => new Promise(() => { /* 永远挂起 */ }) },
        });
        const out = await call(disp, req("debugger", "挂起的分析"));
        expect(out.ok).toBe(false);
        expect(out.code).toBe("SUBAGENT_TIMEOUT");
        expect(out.result.ok).toBe(false);
        expect(out.result.confidence).toBe("low");
        expect(out.result.readonly).toBe(true);                  // 失败壳也过同一 Schema
        expect(ledger.listEvents().some((e) => e.type === "subagent_failed"
            && JSON.stringify(e.payload).includes("SUBAGENT_TIMEOUT"))).toBe(true);
        // 不自动重试：同一签名再来 → 直接复用拒绝
        const again = await call(disp, req("debugger", "挂起的分析"));
        expect(again.code).toBe("SUBAGENT_DUPLICATE_SIGNATURE");
    });

    it("注入 Fake LLM 时：子 Agent 调用产生 llm 记账（预算计入，十.20 配套）", async () => {
        let llmCalls = 0;
        const seen: { role: string; brief: string }[] = [];
        const { disp, ledger } = makeDispatcher({
            subagentLlm: {
                id: "fake-subagent-llm",
                calls: () => llmCalls,
                analyze: async (input) => {
                    llmCalls++;
                    seen.push({ role: input.role, brief: input.contextBrief });
                    return VALID_CANDIDATE;
                },
            },
        });
        const out = await call(disp, req("explorer", "LLM 驱动的分析"));
        expect(out.ok).toBe(true);
        expect(out.llmCallsPlanned).toBe(1);
        expect(out.llmCallsCompleted).toBe(1);
        expect(llmCalls).toBe(1);
        expect(seen[0]?.brief).toContain("package.json");        // 只读证据摘要真的喂给了它
        const evs = ledger.listEvents().map((e) => `${e.type}:${JSON.stringify(e.payload)}`);
        expect(evs.some((e) => e.startsWith("llm_call_planned") && e.includes("subagent"))).toBe(true);
        expect(evs.some((e) => e.startsWith("llm_call_completed") && e.includes("subagent"))).toBe(true);
    });
});

// ============================================================
// 十.17-18 主 Agent 图集成（Fake LLM 脚本驱动，零真实模型）
// ============================================================

const task: ArchitectTask = {
    type: "architect_task", projectId: "p1", taskId: "t1",
    requirementSnapshot: { goal: "便签管理" },
    stackProfile: { frontend: "vue3", backend: "spring-boot" },
    domainModel: { entity: "note", table: "note", fields: [] },
    contract: { version: "1", endpoints: [] },
    foundationPlan: { dirs: ["backend", "frontend"] },
    allowedRoots: ["backend", "frontend"],
    forbiddenPaths: [], acceptanceChecks: [], developerInstructions: "按计划实现",
};

const DONE = { kind: "done" };
const WRITE = { kind: "tool", tool: "writeFile", args: { path: "backend/src/A.java", content: "class A{}" } };
const SUB_Q = (role: string, question: string) => ({ kind: "tool", tool: "delegateReadonly", args: { role, question } });

function scriptedLlm(decisions: unknown[]) {
    const histories: unknown[][] = [];
    let i = 0;
    let calls = 0;
    const llm: DeveloperLlm = {
        id: "fake-llm",
        calls: () => calls,
        async next(input) {
            calls++;
            histories.push(JSON.parse(JSON.stringify(input.history)));
            const d = decisions[Math.min(i, decisions.length - 1)];
            i++;
            return d ?? DONE;
        },
    };
    return { llm, histories, count: () => calls };
}

/** runBuild 走假实现（绝不在测试里真跑 mvnw/npm），其余工具走真实实现 */
function subagentHybridTools(): ToolRegistry {
    return {
        describe: (names?: string[]) => registry.describe(names),
        names: () => registry.names(),
        invoke: async (name: string, ctx: ToolContext, args: ToolArgs) => {
            if (name === "runBuild") return { ok: true, output: "[build] exit=0", meta: { exitCode: 0 } };
            return registry.invoke(name, ctx, args);
        },
    } as unknown as ToolRegistry;
}

const noPort: MessagePort = {
    send: () => "wake",
    receive: async () => ({ status: "invalid", error: "无消息", sender: null }),
};

async function runGraph(o: {
    decisions: unknown[];
    subagentRunners?: Parameters<typeof createReadonlySubAgentDispatcher>[0]["runners"];
}) {
    const ledger = freshLedger();
    const { llm, histories, count } = scriptedLlm(o.decisions);
    const graph = buildDeveloperGraph({
        workspace: ws, tools: subagentHybridTools(), ledger, port: noPort, llm,
        trustedTestAgents: ["test-core"],
        ...(o.subagentRunners ? { subagentRunners: o.subagentRunners } : {}),
    });
    const final = await graph.invoke(initialDeveloperState({
        projectId: "p1", taskId: "t1", runId: "sub-run", projectDir,
        allowedRoots: ["backend", "frontend"],
        correlationId: "corr-sub", messages: [task],
    })) as DeveloperState;
    return { final, ledger, histories, llmCalls: count() };
}

describe("subagent / 主 Agent 图集成（十.17-18 / 六.1）", () => {
    it("⑰ 主 Agent 调用子 Agent、读取结构化结果后，仍由自己写盘继续", async () => {
        const { final, ledger, histories } = await runGraph({
            decisions: [SUB_Q("explorer", "项目结构与入口在哪？"), WRITE, DONE],
        });
        // 子 Agent 结果进了主 Agent 的历史（下一次 LLM 请求能看到 rootCause；
        // 注意 history 再被 stringify 一层，引号是转义形态）。
        // ★ 工作项推进后，每个工作项跑一个**独立** tool loop（任务原子：工作项之间不共享
        //   对话历史，上下文由 renderTask 重渲染）——所以这里断言"存在某一轮输入带子 Agent
        //   结果"，而不是"最后一轮"：最后一轮可能是另一个工作项刚开的新 loop。
        const withSubagent = histories
            .map((h) => JSON.stringify(h ?? []))
            .find((h) => h.includes("rootCause"));
        expect(withSubagent).toBeTruthy();
        expect(withSubagent).toContain("readonly");
        expect(withSubagent).toContain("cannotVerify");
        // 写盘的仍是主 Agent，图正常走到送检
        expect(final.changedFiles).toContain("backend/src/A.java");
        expect(final.status).toBe("waiting_test");
        expect(ledger.listEvents().some((e) => e.type === "subagent_requested")).toBe(true);
        expect(ledger.listEvents().some((e) => e.type === "subagent_completed")).toBe(true);
    });

    it("⑱ 简单任务完全不碰子 Agent（零 subagent 事件）", async () => {
        const { final, ledger } = await runGraph({ decisions: [WRITE, DONE] });
        expect(final.status).toBe("waiting_test");
        expect(ledger.listEvents().filter((e) => e.type.startsWith("subagent_")).length).toBe(0);
        expect(ledger.subagentCallCount()).toBe(0);
    });

    it("一次循环最多一个子 Agent：第二个被闸下（六.1）", async () => {
        let runs = 0;
        const { ledger } = await runGraph({
            decisions: [
                SUB_Q("explorer", "问题一"),
                { kind: "tool", tool: "delegateReadonly", args: { role: "debugger", question: "问题二", evidence: { failureSignature: "sig-loop-2" } } },
                WRITE, DONE,
            ],
            subagentRunners: {
                explorer: async () => { runs++; return VALID_CANDIDATE; },
                debugger: async () => { runs++; return VALID_CANDIDATE; },
            },
        });
        expect(runs).toBe(1);                                    // 第二个子 Agent 根本没执行
        expect(ledger.listEvents().some((e) => e.type === "subagent_failed"
            && JSON.stringify(e.payload).includes("SUBAGENT_ONCE_PER_LOOP"))).toBe(true);
    });
});

// ============================================================
// 附加：协议形状单元断言
// ============================================================

describe("subagent / 接口形状", () => {
    it("请求缺 question / 非法 role 直接拒绝，不跑分析器", async () => {
        let runs = 0;
        const { disp } = makeDispatcher({ runners: { explorer: async () => { runs++; return VALID_CANDIDATE; } } });
        const bad = await disp("T1", { role: "nope" as never, question: "x" });
        expect(bad.ok).toBe(false);
        expect(bad.code).toBe("SUBAGENT_INVALID_REQUEST");
        const empty = await disp("T1", { role: "explorer", question: "" });
        expect(empty.code).toBe("SUBAGENT_INVALID_REQUEST");
        expect(runs).toBe(0);
    });

    it("三事件齐备：requested → completed，且绑定 taskId/signature/snapshot", async () => {
        const { disp, ledger } = makeDispatcher();
        const out = await call(disp, req("explorer", "入账检查", { evidence: { failureSignature: "sig-events" } }));
        expect(out.ok).toBe(true);
        const events = ledger.listEvents().filter((e) => e.type.startsWith("subagent_"));
        expect(events.map((e) => e.type)).toEqual(["subagent_requested", "subagent_completed"]);
        const payload = events[0]!.payload as Record<string, unknown>;
        expect(payload["taskId"]).toBe("T1");
        expect(payload["signature"]).toBe("sig-events");
        expect(payload["snapshotHash"]).toBe(ws.sourceSnapshot().hash);
    });
});
