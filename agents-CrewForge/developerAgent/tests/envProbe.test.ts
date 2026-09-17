// tests/envProbe.test.ts —— 环境自检（9/15，纯函数口径 + 本机集成实测）
//
//   验口径：
//   ① renderEnvBrief 是**纯函数**：只吃手造 EnvProbe，输出可断言——联网态必须说
//      "脚手架可用"，断网态必须说"离线 + 手写"，缺 java/mvn 必须说"不可选"，
//      并且**行数受预算约束**（简报要塞进提示词，不许膨胀）；
//   ② probeEnvironment 在本机**真跑**：结构完整、node/bun 必须报到（本机确实有）、
//      几秒内返回。版本号一律不断言（跨机器会变），只断言形态。
//   ③ offline:true → registry 必须为 null（"不知道"和"不可达"是两种事实，不能混）。
import { describe, expect, it } from "bun:test";
import { probeEnvironment, renderEnvBrief } from "../envProbe";
import type { EnvProbe, ToolProbe } from "../envProbe";

// ------------------------------------------------------------
// 手造数据：让纯函数测试与机器实况解耦
// ------------------------------------------------------------

function tool(name: string, version: string | null = null, available = true): ToolProbe {
    return { name, available, version, path: available ? `C:\\fake\\${name}.exe` : null };
}

/** 造一个"有 npm/node（联网）"的机器画像；逐项用 over 覆盖成想要的场景 */
function makeProbe(over: Partial<EnvProbe> = {}): EnvProbe {
    const base: EnvProbe = {
        probedAt: "2025-09-15T00:00:00.000Z",
        platform: "win32 x64",
        tools: [
            tool("node", "24.8.0"),
            tool("npm", "11.6.0"),
            tool("npx", "11.6.0"),
            tool("bun", "1.3.14"),
            tool("git", "2.43.0.windows.1"),
            tool("java", null, false),
            tool("mvn", null, false),
            tool("gradle", null, false),
            tool("mysql", null, false),
            tool("msedge", null, false),
        ],
        network: { npmRegistry: true, note: "registry 可达（HTTP 200，120ms）" },
        ports: [
            { port: 3000, free: true },
            { port: 5173, free: true },
            { port: 8080, free: false },
        ],
        notes: ["npm 可用（11.6.0）+ registry 可达 → 官方脚手架可用"],
    };
    return { ...base, ...over };
}

describe("envProbe / renderEnvBrief 纯函数口径", () => {
    it("npm + registry 可达 → 简报说「脚手架可用」，且点名官方脚手架", () => {
        const brief = renderEnvBrief(makeProbe());
        expect(brief).toContain("脚手架可用");
        expect(brief).toContain("npm 11.6.0");
        expect(brief).toContain("create vite");
        expect(brief).toContain("**可用的工具链**");     // 分组标题齐备
        expect(brief).toContain("**构建与验证可行性**");
        expect(brief).toContain("**端口**");
        expect(brief).not.toContain("离线");
    });

    it("registry 不可达 → 说「离线」并要求「手写」工程文件", () => {
        const brief = renderEnvBrief(
            makeProbe({
                network: { npmRegistry: false, note: "registry 不可达：fetch failed" },
                notes: ["离线：脚手架不可用，需手写工程文件"],
            }),
        );
        expect(brief).toContain("离线");
        expect(brief).toContain("手写");
        expect(brief).not.toContain("脚手架可用");
    });

    it("缺 java/mvn → 明确写成「不可选」（别让模型去选 JVM 栈）", () => {
        const brief = renderEnvBrief(makeProbe());
        expect(brief).toContain("不可选");
        expect(brief).toContain("java");
        expect(brief).toContain("mvn");
        expect(brief).toContain("java、mvn");           // 不可用清单里逐个点名
    });

    it("端口占用 → 简报点名被占端口并提示别写进配置", () => {
        const brief = renderEnvBrief(makeProbe());
        expect(brief).toContain("8080");
        expect(brief).toContain("3000");
        expect(brief).toContain("空闲");
    });

    it("纯函数 + 有界：同输入同输出、不改入参、行数 ≤ 25 行", () => {
        const p = makeProbe();
        const snapshot = JSON.stringify(p);
        const a = renderEnvBrief(p);
        const b = renderEnvBrief(p);
        expect(a).toBe(b);                              // 确定性
        expect(JSON.stringify(p)).toBe(snapshot);       // 无副作用

        const lines = a.split("\n");
        expect(lines.length).toBeLessThanOrEqual(25);
        expect(lines.length).toBeGreaterThanOrEqual(6);

        // 极端画像：18 个工具全在 + 一堆结论，仍不许越预算
        const fat = makeProbe({
            tools: [
                ...p.tools,
                ...["pnpm", "yarn", "python", "pip", "go", "cargo", "docker", "sqlite3", "zsh", "fish"].map((n) =>
                    tool(n, "1.0.0"),
                ),
            ],
            notes: Array.from({ length: 12 }, (_v, i) => `结论 ${i}`),
        });
        const fatLines = renderEnvBrief(fat).split("\n");
        expect(fatLines.length).toBeLessThanOrEqual(25);
        // 工具多时是**折叠**（"等 N 个"）而不是把每行撑爆：提示词预算要靠设计守住
        expect(renderEnvBrief(fat)).toContain("等 15 个");
    });

    it("空画像（什么都没探到）不炸：仍是可读简报，不出现 undefined", () => {
        const brief = renderEnvBrief(
            makeProbe({
                tools: [],
                ports: [],
                network: { npmRegistry: null, note: "offline 模式：未探测 registry 可达性" },
                notes: [],
            }),
        );
        expect(brief).toContain("环境自检");
        expect(brief).not.toContain("undefined");
        expect(brief.split("\n").length).toBeLessThanOrEqual(25);
    });
});

describe("envProbe / probeEnvironment 本机实测", () => {
    it("返回结构完整的 EnvProbe；node/bun 报可用；几秒内跑完", async () => {
        const t0 = Date.now();
        const p = await probeEnvironment({ refresh: true });
        const ms = Date.now() - t0;

        // 形态：必需字段齐全
        expect(typeof p.probedAt).toBe("string");
        expect(Number.isNaN(Date.parse(p.probedAt))).toBe(false);
        expect(p.platform.length).toBeGreaterThan(0);
        expect(Array.isArray(p.tools)).toBe(true);
        expect(Array.isArray(p.ports)).toBe(true);
        expect(typeof p.network.note).toBe("string");
        expect(Array.isArray(p.notes)).toBe(true);
        expect(["boolean", "object"]).toContain(typeof p.network.npmRegistry);  // true/false/null

        // 清单必须齐全（18 个关键二进制一个不少）
        const names = p.tools.map((t) => t.name);
        for (const need of [
            "node", "npm", "npx", "pnpm", "yarn", "bun", "java", "mvn", "gradle",
            "python", "pip", "go", "cargo", "docker", "git", "mysql", "sqlite3", "msedge",
        ]) {
            expect(names).toContain(need);
        }
        expect(p.tools.length).toBe(18);

        // 每条 ToolProbe 自洽：不可用 ⇒ 无版本无路径
        for (const t of p.tools) {
            expect(typeof t.name).toBe("string");
            expect(typeof t.available).toBe("boolean");
            if (!t.available) {
                expect(t.version).toBeNull();
                expect(t.path).toBeNull();
            } else {
                expect(typeof t.path).toBe("string");
            }
        }

        // 本机事实：node / bun 一定有（跑测试的就是 bun，node v24 也在 PATH 上）
        const node = p.tools.find((t) => t.name === "node");
        const bun = p.tools.find((t) => t.name === "bun");
        expect(node?.available).toBe(true);
        expect(bun?.available).toBe(true);
        expect(node?.path).not.toBeNull();
        // 版本形态（不钉具体版本号：换机器就变）
        expect(node?.version).toMatch(/^\d+\.\d+/);
        expect(bun?.version).toMatch(/^\d+\.\d+/);

        // 默认端口清单与结论
        expect(p.ports.map((x) => x.port)).toEqual([3000, 5173, 8080, 8000]);
        for (const pt of p.ports) expect(typeof pt.free).toBe("boolean");

        // 并发 + 硬超时：18 个探针 + 网络 + 4 端口不该串行累加
        expect(ms).toBeLessThan(15000);
    }, 30000);

    it("offline:true → registry 记 null（不知道），notes 说明离线", async () => {
        const p = await probeEnvironment({ refresh: true, offline: true, ports: [34567], timeoutMs: 4000 });
        expect(p.network.npmRegistry).toBeNull();
        expect(p.network.note).toContain("offline");
        expect(p.ports.map((x) => x.port)).toEqual([34567]);
        expect(typeof p.ports[0]?.free).toBe("boolean");       // noUncheckedIndexedAccess：索引是可选值
        // offline 下不许出现"网络不可达"式的假事实
        expect(p.network.note).not.toContain("不可达");
    }, 30000);

    it("端口参数被规范化：去重、非法值丢弃、超量截断", async () => {
        const p = await probeEnvironment({
            refresh: true,
            offline: true,
            timeoutMs: 4000,
            ports: [34570, 34570, -1, 70000, 1.5, 34571],
        });
        expect(p.ports.map((x) => x.port)).toEqual([34570, 34571]);
    }, 30000);

    it("60s 内重复调用命中缓存（同一对象）；refresh:true 强制重探", async () => {
        const a = await probeEnvironment({ refresh: true, offline: true, ports: [34572], timeoutMs: 4000 });
        const b = await probeEnvironment({ offline: true, ports: [34572], timeoutMs: 4000 });
        expect(b).toBe(a);                                     // 缓存：同一引用
        const c = await probeEnvironment({ refresh: true, offline: true, ports: [34572], timeoutMs: 4000 });
        expect(c).not.toBe(a);                                 // 强制重探：新对象
        expect(c.probedAt.length).toBeGreaterThan(0);
    }, 30000);

    it("真跑结果能直接渲染成简报（两个 API 串起来不打架）", async () => {
        const p = await probeEnvironment({ refresh: true });
        const brief = renderEnvBrief(p);
        expect(brief).toContain("环境自检");
        expect(brief.split("\n").length).toBeLessThanOrEqual(25);
        // 本机 npm+registry 至少有一个定论（可达 / 不可达 / 未探测），必须是三态之一且写清了
        expect(p.network.npmRegistry === true || p.network.npmRegistry === false || p.network.npmRegistry === null).toBe(true);
    }, 30000);
});
