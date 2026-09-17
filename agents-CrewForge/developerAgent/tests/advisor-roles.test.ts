// ============================================================
// tests/advisor-roles.test.ts —— 可召唤专家（9/17 拓扑升级）
//
//   守住的东西：**多 agent 从"接力"改成"召唤"**之后，两个顾问角色真的能干活、
//   真的只读、真的把结构性缺口点出来（而不是给一段空话）。
//   背景：以前 PM/架构师/测试/维护者只在流水线固定位置出现一次，中间失忆；
//   现在司机可以在自己的循环里随时召唤架构审与验收审——这是多 agent 卖点的升级，
//   也是"卡住不是只能硬扛"的另一条路。
// ============================================================

import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeveloperLedger } from "../ledger";
import { Workspace } from "../workspace";
import { createFullDeveloperToolRegistry } from "../tools/registry";
import { delegateReadonlyTool } from "../tools/delegateReadonly";
import {
    READONLY_SUBAGENT_ROLES, SUBAGENT_ROLE_PROMPTS, ReadonlySubAgentRequestSchema,
    createReadonlySubAgentDispatcher,
} from "../tools/readonlySubAgent";
import type { ReadonlySubAgentRequest } from "../tools/readonlySubAgent";

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-advisor-"));
const w = (rel: string, content: string) => {
    const abs = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
};

// 夹具刻意复刻两起真实事故的形状：
//   R6 白屏——有路由文件，但路由表为空（一个 path 都没登记）
//   R8 500——写了 ddl.sql，但全项目没有一处引用它（启动流程没接）
w("frontend/package.json", JSON.stringify({ name: "fe", dependencies: { vue: "^3.4.0" } }));
w("frontend/src/main.ts", "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n");
w("frontend/src/router/index.ts", "const routes = [];\nexport default routes;\n");
w("frontend/src/App.vue", "<template>\n  <router-view/>\n</template>\n");
w("backend/package.json", JSON.stringify({ name: "be", dependencies: { express: "^4.19.0" } }));
w("backend/src/app.js", "const app = require('express')();\napp.post('/api/notes', (req, res) => res.status(201).json({ id: 1 }));\napp.get('/api/notes', (req, res) => res.json([]));\nmodule.exports = app;\n");
w("ddl.sql", "CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT);\n");

const ws = new Workspace({ projectDir, allowedRoots: ["backend", "frontend"] });
const registry = createFullDeveloperToolRegistry();
const opened: DeveloperLedger[] = [];
let seq = 0;
afterAll(() => {
    for (const l of opened) l.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
});

function makeDispatcher() {
    const ledger = DeveloperLedger.open(path.join(projectDir, `adv-${seq++}.db`), "p1:t1:adv");
    opened.push(ledger);
    const disp = createReadonlySubAgentDispatcher({ workspace: ws, tools: registry, ledger, maxCallsPerTask: 20 });
    return disp;
}
const call = (disp: ReturnType<typeof createReadonlySubAgentDispatcher>, r: ReadonlySubAgentRequest) => disp("T1", r);

describe("advisor / 角色注册与协议", () => {
    it("两个顾问角色进了权威清单（团队不删工位，只加「可召唤」通道）", () => {
        expect(READONLY_SUBAGENT_ROLES).toContain("architect-advisor");
        expect(READONLY_SUBAGENT_ROLES).toContain("acceptance-advisor");
        expect(READONLY_SUBAGENT_ROLES.length).toBe(5);
        // 原有三角色一个没少（升级不是替换）
        for (const r of ["explorer", "debugger", "ui-reviewer"] as const) {
            expect(READONLY_SUBAGENT_ROLES).toContain(r);
        }
    });

    it("两个角色的提示词都在（不是只有名字）", () => {
        expect(SUBAGENT_ROLE_PROMPTS["architect-advisor"].length).toBeGreaterThan(40);
        expect(SUBAGENT_ROLE_PROMPTS["acceptance-advisor"].length).toBeGreaterThan(40);
    });

    it("请求 Schema 接受新角色", () => {
        expect(ReadonlySubAgentRequestSchema.safeParse({ role: "architect-advisor", question: "结构有没有缺口" }).success).toBe(true);
        expect(ReadonlySubAgentRequestSchema.safeParse({ role: "acceptance-advisor", question: "验收会挂在哪" }).success).toBe(true);
        expect(ReadonlySubAgentRequestSchema.safeParse({ role: "nope", question: "x" }).success).toBe(false);
    });

    it("工具描述里点名了顾问角色（模型才找得到这条路）", () => {
        const d = delegateReadonlyTool.description;
        expect(d).toContain("architect-advisor");
        expect(d).toContain("acceptance-advisor");
    });
});

describe("advisor / 架构审：在跑偏之前叫停", () => {
    it("空路由表 + 没人用的 DDL 都要点出来，且只读、说清不能确认什么", async () => {
        const out = await call(makeDispatcher(), { role: "architect-advisor", question: "结构上有什么缺口？" });
        expect(out.ok).toBe(true);
        expect(out.result.role).toBe("architect-advisor");   // 角色由框架固定，防串角
        expect(out.result.readonly).toBe(true);
        const blob = JSON.stringify(out.result);
        expect(blob).toContain("router");                    // 路由文件被识别
        expect(blob).toContain("白屏");                       // R6 的形状被点出
        expect(blob).toContain("ddl.sql");                    // R8 的形状被点出
        expect(out.result.cannotVerify.length).toBeGreaterThan(0);
        // 顾问不许越权：不能宣布"通过/完成"
        expect(blob).not.toContain("\"verified\":true");
    });
});

describe("advisor / 验收审：预判拿去验收会挂在哪", () => {
    it("静态接口清单能列出来；缺 409 分支要作为风险提示", async () => {
        const out = await call(makeDispatcher(), { role: "acceptance-advisor", question: "这套东西拿去验收会挂在哪？" });
        expect(out.ok).toBe(true);
        expect(out.result.role).toBe("acceptance-advisor");
        const blob = JSON.stringify(out.result);
        expect(blob).toContain("app.js");                    // 找到后端接口所在文件
        expect(out.result.risks.join(" ")).toContain("409");  // 状态码语义缺口被提示
        // 没有执行权就必须如实说：不能声称验证过状态码
        expect(out.result.cannotVerify.join(" ")).toContain("状态码");
    });
});
