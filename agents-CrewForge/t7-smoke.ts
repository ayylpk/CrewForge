// ============================================================
// t7-smoke.ts —— T7a 令牌闸冒烟（9/8，确定性层零 LLM 零 DB）
//
//   用户拍板的模型兑现成可测断言：
//     ①队列无上限（WorkQueue 没动，这里不测）；token 限在制：领到才干活，满了挂等
//     ②归还语义：finally 归还——任务成功/失败/异常都回到池子，绝不漏发
//     ③invokeWithTimeout 挂最外层闸：排队时间不吃调用超时（先领票再开表）——
//       否则闸口排队会被误判成"模型慢"掐死，9/2 超时冤案的翻版
//     ④限额兜底：settings 读不到=出厂值（llm 6 / slots 5）；0/负数 clamp 到 1（闸不能焊死）
//   跑法：bun run t7-smoke.ts
// ============================================================

import { gate, pinGateLimit } from "./concurrency";
import { invokeWithTimeout } from "./llm";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, extra = "") {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
    console.log("=== ① 在制 ≤ 限额（5 单挤 2 票） ===");
    pinGateLimit("t7-test-a", 2);
    const g = gate("t7-test-a");
    let inflight = 0, peak = 0;
    const jobs = Array.from({ length: 5 }, async () => {
        await g.acquire();
        try {
            inflight++; peak = Math.max(peak, inflight);
            await sleep(40);
            inflight--;
        } finally {
            g.release();
        }
    });
    await Promise.all(jobs);
    ok(peak === 2 && g.stats().inUse === 0, `峰值在制=2、全部归还`, JSON.stringify(g.stats()) + ` peak=${peak}`);
    ok(g.stats().waiting === 0, "无人滞留队列");

    console.log("=== ② 异常也归还（finally 语义） ===");
    const boom = async () => {
        await g.acquire();
        try { throw new Error("工位炸了"); } finally { g.release(); }
    };
    let threw = false;
    try { await boom(); } catch { threw = true; }
    ok(threw && g.stats().inUse === 0, "抛异常后令牌回池，闸不死锁");

    console.log("=== ③ 排队不吃超时（先领票再开表） ===");
    pinGateLimit("llm", 1);
    const lg = gate("llm");
    let llmPeak = 0, llmNow = 0;
    const call = (label: string, ms: number, budget: number) =>
        invokeWithTimeout(label, budget, async () => {
            llmNow++; llmPeak = Math.max(llmPeak, llmNow);
            await sleep(ms);
            llmNow--;
            return label;
        });
    const t0 = Date.now();
    // A 慢票 120ms（预算 500）；B 快票预算 60ms 但排在 A 后面 ≥120ms——
    // 旧实现（开表早于领票）B 必被"超时"误杀；新实现 B 领到票才开始 60ms 计时
    const [ra, rb] = await Promise.all([call("A", 120, 500), (async () => { await sleep(10); return call("B", 20, 60); })()]);
    ok(ra === "A" && rb === "B", "被排队的快调用不被超时误杀", `rb=${rb}`);
    ok(llmPeak === 1 && Date.now() - t0 >= 130, "llm 闸=1 时严格串行（峰值在飞 1）", `peak=${llmPeak}`);
    ok(lg.stats().inUse === 0 && lg.stats().waiting === 0, "出口干净");
    pinGateLimit("llm", null);

    console.log("=== ④ 出厂兜底与 clamp ===");
    ok(gate("x-backend.code").stats().limit === 5, "无 settings：阶段闸出厂 5");
    ok(gate("llm").stats().limit === 6, "无 settings：端点闸出厂 6");
    pinGateLimit("t7-test-a", 0);
    ok(gate("t7-test-a").stats().limit === 1, "手滑填 0 → clamp 1（闸不能焊死）");
    pinGateLimit("t7-test-a", null);

    console.log(`\n=== 汇总：${pass} 绿 / ${fail} 红 ===`);
    if (fail > 0) process.exit(1);
}

main().catch(e => { console.error("冒烟脚本自身炸了:", e); process.exit(2); });
