// ============================================================
// tests/verify.test.ts —— --verify 只读验收模式的零 LLM 测试
//
//   跑法（注意仓库根 `bun test` 会连 evals/fixtures 里的"故意失败"考卷一起吃掉，
//   那些是 --auto 的评测夹具不是本仓测试）：
//     bun test tests/
//
//   覆盖结构裁决第七节中与 verify 相关的条目：
//   1 全过 / 2 一条失败 / 3 命令不存在 / 4 超时 / 5 列表空 / 6 不调 LLM /
//   7 不 edit-write / 8 cwd 越界 / 9 stdout 单 JSON / 10 身份非法 / 11 旧 auto 路径不回归
// ============================================================

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runVerify, verifyExitCode } from "../src/verify";

// ---------- 夹具 ----------

let root: string;      // 临时"目标项目"
const files: Record<string, string> = {};

function req(overrides: Partial<Record<string, unknown>> = {}): unknown {
    return {
        type: "test_request",
        projectId: "demo", taskId: "demo-p1", runId: "run-1",
        correlationId: "corr-1", acceptanceHash: "hash-abc",
        projectDir: root,
        acceptanceChecks: [],
        ...overrides,
    };
}

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-verify-"));
    fs.mkdirSync(path.join(root, "backend"), { recursive: true });
    files.marker = path.join(root, "marker.txt");
    fs.writeFileSync(files.marker, "do-not-touch\n");
});
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清不掉不拦测试 */ } });

const OK = { id: "ok", category: "COMPILE", command: "node", args: ["-e", "console.log('hello')"] };
const BAD = { id: "bad", category: "CONTRACT", command: "node", args: ["-e", "console.error('boom'); process.exit(3)"] };

// ---------- 1. 全部通过 ----------

describe("verify / 判定规则", () => {
    test("1 所有验收项真实执行且 exit=0、skipped 空 → pass；证据字段齐全", async () => {
        const r = await runVerify(req({ acceptanceChecks: [OK, { ...OK, id: "ok2" }] }));
        expect(r.verdict).toBe("pass");
        expect(r.skipped).toEqual([]);
        expect(r.failure).toBeNull();
        expect(r.allFailures).toEqual([]);
        expect(r.evidence.length).toBe(2);
        const e = r.evidence[0]!;
        expect(e.exitCode).toBe(0);
        expect(e.stdout).toContain("hello");
        expect(typeof e.startedAt).toBe("number");
        expect(e.durationMs).toBeGreaterThanOrEqual(0);
        expect(e.timedOut).toBe(false);
        // 身份原样回带（适配器要拿它做五字段核对）
        expect([r.projectId, r.taskId, r.runId, r.correlationId, r.acceptanceHash])
            .toEqual(["demo", "demo-p1", "run-1", "corr-1", "hash-abc"]);
    });

    test("2 一条真实失败 → fail，failure 指向该项，exit≠0 如实记录", async () => {
        const r = await runVerify(req({ acceptanceChecks: [OK, BAD, { ...OK, id: "ok3" }] }));
        expect(r.verdict).toBe("fail");
        expect(r.failure?.checkId).toBe("bad");
        expect(r.failure?.exitCode).toBe(3);
        expect(r.failure?.stderr).toContain("boom");
        expect(r.allFailures.map((x) => x.checkId)).toEqual(["bad"]);
        // 不短路：全量执行，证据完整（报告要能看全貌）
        expect(r.evidence.length).toBe(3);
    });

    test("3 命令不存在 → 未执行 → blocked_unverified（不是 fail，绝不 pass）", async () => {
        const r = await runVerify(req({
            acceptanceChecks: [OK, { id: "ghost", command: "qq-definitely-not-installed-9x7" }],
        }));
        expect(r.verdict).toBe("blocked_unverified");
        expect(r.skipped.some((s) => s.checkId === "ghost")).toBe(true);
        expect(r.failure).toBeNull();
    });

    test("4 命令超时 → timedOut + exitCode null → fail（真实尝试过，非未执行）", async () => {
        const r = await runVerify(req({
            acceptanceChecks: [{ id: "slow", command: "node", args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 400 }],
        }));
        expect(r.verdict).toBe("fail");
        expect(r.failure?.timedOut).toBe(true);
        expect(r.failure?.exitCode).toBeNull();
    }, 20_000);

    test("5 acceptanceChecks 为空 / 输入非法 / 身份缺失 → error", async () => {
        expect((await runVerify(req({ acceptanceChecks: [] }))).verdict).toBe("error");
        expect((await runVerify("not an object")).verdict).toBe("error");
        expect((await runVerify(null)).verdict).toBe("error");
        const noId = await runVerify(req({ projectId: "", acceptanceChecks: [OK] }));
        expect(noId.verdict).toBe("error");
        expect(noId.error).toContain("projectId");
        // error 也要把已有的身份字段原样带回（尽量给适配器留对账线索）
        expect(noId.taskId).toBe("demo-p1");
        expect((await runVerify(req({ projectDir: "Q:/no/such/dir-xyz", acceptanceChecks: [OK] }))).verdict).toBe("error");
    });

    test("10 cwd 越界（跳出 projectDir）被拒绝 → skipped → blocked_unverified", async () => {
        const r = await runVerify(req({ acceptanceChecks: [{ ...OK, id: "esc", cwd: "../../.." }] }));
        expect(r.verdict).toBe("blocked_unverified");
        expect(r.skipped[0]?.reason).toContain("越界");
        const r2 = await runVerify(req({ acceptanceChecks: [{ ...OK, id: "abs", cwd: process.platform === "win32" ? "C:/Windows" : "/etc" }] }));
        expect(r2.verdict).toBe("blocked_unverified");
    });

    test("退出码映射：pass=0 / fail=1 / blocked=1 / error=2", () => {
        expect(verifyExitCode("pass")).toBe(0);
        expect(verifyExitCode("fail")).toBe(1);
        expect(verifyExitCode("blocked_unverified")).toBe(1);
        expect(verifyExitCode("error")).toBe(2);
    });
});

// ---------- 三. 完整失败证据（allFailures）：不许只交第一条红项 ----------

describe("verify / allFailures 完整红单", () => {
    test("两条验收失败 → allFailures 两项；第一条 failure 仍指向第一条失败", async () => {
        const r = await runVerify(req({
            acceptanceChecks: [OK, BAD, { ...BAD, id: "bad2", args: ["-e", "console.error('boom2'); process.exit(5)"] }],
        }));
        expect(r.verdict).toBe("fail");
        expect(r.allFailures.map((x) => x.checkId)).toEqual(["bad", "bad2"]);
        expect(r.allFailures.length).toBe(2);
        // 主失败项 = 第一条真实失败（Developer 先修这条）
        expect(r.failure?.checkId).toBe("bad");
        expect(r.failure?.exitCode).toBe(3);
        // 逐条红项都带各自的原始输出，不是同一条复制两遍
        expect(r.allFailures[1]!.stderr).toContain("boom2");
        expect(r.allFailures[1]!.exitCode).toBe(5);
        // 没有失败的项不进红单
        expect(r.allFailures.some((x) => x.checkId === "ok")).toBe(false);
    });

    test("超时（exitCode=null）必须进入 allFailures——null ≠ 0", async () => {
        const r = await runVerify(req({
            acceptanceChecks: [OK, { id: "slow", command: "node", args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 400 }],
        }));
        expect(r.verdict).toBe("fail");
        expect(r.allFailures.map((x) => x.checkId)).toEqual(["slow"]);
        expect(r.allFailures[0]!.exitCode).toBeNull();
        expect(r.allFailures[0]!.timedOut).toBe(true);
    });

    test("skipped 不得进 allFailures，也不得被当成 pass", async () => {
        const r = await runVerify(req({
            acceptanceChecks: [OK, { id: "ghost", command: "qq-definitely-not-installed-9x7" }],
        }));
        expect(r.verdict).toBe("blocked_unverified");
        expect(r.allFailures).toEqual([]);
        expect(r.failure).toBeNull();
        // 没执行 = 没有证据，绝不能凭空生出"通过证据"
        expect(r.evidence.map((e) => e.checkId)).toEqual(["ok"]);
        expect(r.skipped.map((s) => s.checkId)).toEqual(["ghost"]);
    });

    test("红单条目必须保留完整失败现场（不压成一句摘要）", async () => {
        const r = await runVerify(req({ acceptanceChecks: [BAD] }));
        const f = r.allFailures[0]! as unknown as Record<string, unknown>;
        for (const k of [
            "checkId", "category", "command", "args", "cwd", "exitCode",
            "timedOut", "stdout", "stderr", "startedAt", "finishedAt", "durationMs",
        ]) {
            expect(k in f).toBe(true);
        }
        expect(f["exitCode"]).toBe(3);
        expect(String(f["stderr"])).toContain("boom");
    });

    test("请求里塞伪造的 allFailures 字段 → 不参与判定（判定只认真实执行证据）", async () => {
        const r = await runVerify(req({
            acceptanceChecks: [OK],
            allFailures: [{ checkId: "forged", exitCode: 1, stdout: "", stderr: "forged" }],
            verdict: "fail",
        }));
        // 真实执行全绿 → pass 不受请求方自述影响
        expect(r.verdict).toBe("pass");
        expect(r.allFailures).toEqual([]);
    });
});

// ---------- 机械证据 + LLM 审查（Fake LLM，离线）----------

/** 假审查模型：脚本化回复 + 调用计数（用来证明"默认不开审查时不碰模型"） */
function fakeReviewer(text?: string, fail?: string) {
    const self = {
        id: "fake-reviewer", calls: 0,
        async complete() {
            self.calls++;
            if (fail) throw new Error(fail);
            return { text: text ?? '{"reviewVerdict":"pass","findings":[],"confidence":"high"}', usage: null };
        },
    };
    return self;
}

const reviewOpts = (llm: ReturnType<typeof fakeReviewer>, enabled = true) =>
    ({ review: { llm, enabled } });

function projWith(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-verify-rev-"));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return dir;
}

describe("verify / 机械 verdict 与审查的关系", () => {
    test("默认不开审查：reviewStatus=disabled，且一次模型都不调（零 LLM 承诺不变）", async () => {
        const llm = fakeReviewer();
        const r = await runVerify(req({ acceptanceChecks: [OK] }), reviewOpts(llm, false));
        expect(r.verdict).toBe("pass");                 // 机械 verdict 照旧
        expect(r.reviewStatus).toBe("disabled");
        expect(r.llmReview).toBeNull();
        expect(llm.calls).toBe(0);
        expect(r.outcome).toBe("llm_unavailable");      // 没有审查就不算通过
    });

    test("机械 verdict 只由 exitCode / evidence / skipped 算，审查改不动它", async () => {
        const dir = projWith({ "backend/src/a.js": "export const a = 1;\n" });
        const llm = fakeReviewer(JSON.stringify({
            reviewVerdict: "fail", confidence: "high",
            findings: [{ severity: "critical", category: "PLACEHOLDER", title: "全是占位", evidence: ["x"], recommendation: "重写" }],
        }));
        const green = await runVerify(req({ projectDir: dir, acceptanceChecks: [OK] }), reviewOpts(llm));
        expect(green.verdict).toBe("pass");             // 机械全绿 → 机械 verdict 还是 pass
        expect(green.outcome).not.toBe("pass");         // 但最终不许通过

        const red = await runVerify(req({ projectDir: dir, acceptanceChecks: [OK, BAD] }), reviewOpts(fakeReviewer()));
        expect(red.verdict).toBe("fail");               // 机械红 → 机械 verdict 是 fail
        expect(red.outcome).toBe("fail");
    }, 30_000);

    test("机械失败 + LLM 发现 → 两部分一起回带（allFailures 与 llmReview 同时在场）", async () => {
        const dir = projWith({ "backend/src/a.js": "export const a = 1;\n" });
        const llm = fakeReviewer(JSON.stringify({
            reviewVerdict: "fail", confidence: "high",
            findings: [
                { severity: "major", category: "PERSISTENCE", title: "内存数组冒充数据库", evidence: ["backend/src/a.js:1"], recommendation: "落 sqlite" },
                { severity: "minor", category: "OTHER", title: "缺错误日志", evidence: ["backend/src/a.js:1"], recommendation: "补日志" },
            ],
        }));
        const r = await runVerify(req({
            projectDir: dir,
            acceptanceChecks: [OK, BAD, { ...BAD, id: "bad2" }],
        }), reviewOpts(llm));
        expect(r.verdict).toBe("fail");
        expect(r.allFailures.map((x) => x.checkId)).toEqual(["bad", "bad2"]);   // 机械红单两条
        expect(r.failure?.checkId).toBe("bad");
        expect(r.llmReview?.findings.length).toBe(2);                          // 模型 findings 两条
        expect(r.blockingFindings.map((f) => f.title)).toContain("内存数组冒充数据库");
        expect(r.outcome).toBe("fail");
    }, 30_000);

    test("机械 pass 但 LLM 报 critical → 最终不是 pass", async () => {
        const dir = projWith({ "backend/src/a.js": "export const a = 1;\n" });
        const llm = fakeReviewer(JSON.stringify({
            reviewVerdict: "pass", confidence: "high",
            findings: [{ severity: "critical", category: "SPEC_GAMING", title: "固定值特殊分支", evidence: ["backend/src/a.js:1"], recommendation: "删掉" }],
        }));
        const r = await runVerify(req({ projectDir: dir, acceptanceChecks: [OK] }), reviewOpts(llm));
        expect(r.verdict).toBe("pass");
        expect(r.outcome).toBe("fail");
        expect(r.blockingFindings.length).toBe(1);
    }, 30_000);

    test("审查不可用 → outcome=llm_unavailable（不伪装通过，也不伪装失败）", async () => {
        const dir = projWith({ "backend/src/a.js": "export const a = 1;\n" });
        const r = await runVerify(req({ projectDir: dir, acceptanceChecks: [OK] }), reviewOpts(fakeReviewer(undefined, "402")));
        expect(r.verdict).toBe("pass");
        expect(r.reviewStatus).toBe("LLM_REVIEW_UNAVAILABLE");
        expect(r.outcome).toBe("llm_unavailable");
        expect(r.reviewReason).toContain("402");
    }, 30_000);

    test("审查审计字段随结果回带（供上游落 Ledger）", async () => {
        const dir = projWith({ "backend/src/a.js": "export const a = 1;\n" });
        const r = await runVerify(req({ projectDir: dir, acceptanceChecks: [OK] }), reviewOpts(fakeReviewer()));
        expect(r.reviewAudit?.model).toBe("fake-reviewer");
        expect(r.reviewAudit?.promptHash).toMatch(/^[0-9a-f]{8,}$/);
        expect(r.reviewAudit?.evidenceHash).toMatch(/^[0-9a-f]{8,}$/);
        expect(typeof r.reviewAudit?.durationMs).toBe("number");
    }, 30_000);

    test("输入非法（error 出口）不触发审查", async () => {
        const llm = fakeReviewer();
        const r = await runVerify(req({ acceptanceChecks: [] }), reviewOpts(llm));
        expect(r.verdict).toBe("error");
        expect(llm.calls).toBe(0);
        expect(r.outcome).toBe("error");
    });
});

// ---------- 6/7. 零 LLM 与只读：结构 + 运行时双钉 ----------

describe("verify / 铁律", () => {
    test("6 结构性零 LLM：verify.ts 不引用 main/models/tool/langchain/openai", () => {
        const src = fs.readFileSync(path.join(import.meta.dir, "..", "src", "verify.ts"), "utf-8");
        const importLines = src.split(/\r?\n/).filter((l) => /^\s*(import|require|from)\b/.test(l) || /import\(/.test(l));
        for (const line of importLines) {
            expect(/main|models|tool|langchain|openai/i.test(line)).toBe(false);
        }
    });

    test("7 只读：跑一轮验收后目标项目文件一字未变（无新增、无改动）", async () => {
        // 用私有子目录当"目标项目"——避免与 CLI 用例往共享 root 里写 req.json 串扰
        const proj = path.join(root, "proj7");
        fs.mkdirSync(path.join(proj, "backend"), { recursive: true });
        fs.writeFileSync(path.join(proj, "marker.txt"), "do-not-touch\n");
        const snapshot = (): Map<string, string> => {
            const m = new Map<string, string>();
            const walk = (d: string): void => {
                for (const f of fs.readdirSync(d, { withFileTypes: true })) {
                    const p = path.join(d, f.name);
                    if (f.isDirectory()) walk(p);
                    else m.set(p, Bun.hash(fs.readFileSync(p)).toString());
                }
            };
            walk(proj);
            return m;
        };
        const before = snapshot();
        await runVerify(req({ projectDir: proj, acceptanceChecks: [OK, BAD, { ...OK, id: "in-sub", cwd: "backend" }] }));
        const after = snapshot();
        expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
        for (const [p, h] of before) expect(after.get(p)).toBe(h);
    }, 20_000);
});

// ---------- CLI 集成：stdout 单 JSON、无 key 也能跑、旧 auto 路径不回归 ----------

const INDEX = path.join(import.meta.dir, "..", "index.ts");

async function runCli(args: string[], env: Record<string, string>) {
    const proc = Bun.spawn([process.execPath, "run", INDEX, ...args], {
        cwd: root, // 故意不在 testAgent 仓内：.env 不会被 dotenv 摸到
        stdout: "pipe", stderr: "pipe", env,
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
}

const MIN_ENV: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", COMSPEC: process.env.COMSPEC ?? "C:\\Windows\\system32\\cmd.exe" } : {}),
};

describe("verify / CLI 契约", () => {
    test("9 --verify：DEEPSEEK 三件套全不可用仍跑通，stdout 是且仅是一份 JSON", async () => {
        const reqFile = path.join(root, "req.json");
        fs.writeFileSync(reqFile, JSON.stringify(req({ acceptanceChecks: [OK] })));
        const { code, stdout, stderr } = await runCli(["--verify", "--input", reqFile], MIN_ENV);
        expect(code).toBe(0);
        const parsed = JSON.parse(stdout); // 混进一行日志都会在这里炸
        expect(parsed.verdict).toBe("pass");
        expect(parsed.acceptanceHash).toBe("hash-abc");
        expect(stderr).toContain("[verify]"); // 日志只准走 stderr
    }, 30_000);

    test("--verify 缺 --input / 输入文件坏 → error JSON + 退出码 2，不崩栈", async () => {
        const a = await runCli(["--verify"], MIN_ENV);
        expect(a.code).toBe(2);
        expect(JSON.parse(a.stdout).verdict).toBe("error");
        fs.writeFileSync(path.join(root, "broken.json"), "{not json");
        const b = await runCli(["--verify", "--input", path.join(root, "broken.json")], MIN_ENV);
        expect(b.code).toBe(2);
        expect(JSON.parse(b.stdout).verdict).toBe("error");
    }, 30_000);

    test("11 --auto 旧路径不回归：检不出测试命令仍 fail-fast（exit 2 + JSON error），且不误入 verify", async () => {
        // 假 key 只为让 ChatOpenAI 构造过关——fail-fast 在 runAgent 之前，不触网、不烧真实 LLM
        const { code, stdout } = await runCli(["--auto", "--json"],
            { ...MIN_ENV, DEEPSEEK_API_KEY: "sk-dummy-not-used", DEEPSEEK_BASE_URL: "http://127.0.0.1:9", DEFAULT_MODEL: "dummy" });
        // root 里没有 package.json/pom.xml → 伤③的 fail-fast 原语义
        expect(code).toBe(2);
        const v = JSON.parse(stdout);
        expect(v.verdict).toBe("error");
        expect(v.summary).toContain("测试命令");
        // --json 单用仍被拒（旧守卫）
        const g = await runCli(["--json"], MIN_ENV);
        expect(g.code).toBe(2);
        expect(g.stderr).toContain("--json 仅配合 --auto");
    }, 30_000);
});
