/**
 * 并发吞吐探针 —— 回答一个决定性问题：
 * 「同时发 N 个请求，每个请求的延迟会不会退化成 N 倍？」
 *
 * 这直接决定"并行多工位 / 多 checkpoint"值不值得做：
 *   · 若 3 并发 ≈ 1 并发延迟 → 网关按请求计费，开并行 = 线性提速，值得做
 *   · 若 3 并发 ≈ 3× 延迟     → 网关按账号串行，开并行 = 白折腾，还多烧配额
 *
 * 用法：bun run live/concurrency-probe.ts
 */
import { loadDotEnv } from "../dotenv";

loadDotEnv();

const BASE = process.env["ANTHROPIC_BASE_URL"] ?? "";
const TOKEN = process.env["ANTHROPIC_AUTH_TOKEN"] ?? "";
const MODEL = process.env["DEVELOPER_LLM_MODEL"] ?? "qwen3.8-flash";

if (!BASE || !TOKEN) {
    console.error("缺 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN");
    process.exit(1);
}

/** 一次真实调用，返回耗时与 token 用量 */
async function oneCall(tag: string): Promise<{ tag: string; ms: number; out: number }> {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/messages`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": TOKEN,
            "authorization": `Bearer ${TOKEN}`,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 400,
            messages: [{
                role: "user",
                content: "请写一段约 150 字的说明，解释什么是 HTTP 幂等性。直接给正文，不要标题。",
            }],
        }),
    });
    const data = await res.json() as {
        content?: { text?: string }[];
        usage?: { output_tokens?: number };
        error?: unknown;
    };
    const ms = Date.now() - t0;
    if (data.error) throw new Error(`${tag}: ${JSON.stringify(data.error).slice(0, 160)}`);
    const out = data.usage?.output_tokens ?? 0;
    return { tag, ms, out };
}

function report(label: string, rows: { tag: string; ms: number; out: number }[]): number {
    const avg = rows.reduce((a, r) => a + r.ms, 0) / rows.length;
    const tokens = rows.reduce((a, r) => a + r.out, 0);
    const tps = tokens / (avg / 1000);
    console.log(
        `${label}: 平均 ${(avg / 1000).toFixed(1)}s  ` +
        `(各次 ${rows.map((r) => (r.ms / 1000).toFixed(1) + "s").join(" / ")})  ` +
        `${tokens} tok  吞吐 ${tps.toFixed(1)} tok/s`,
    );
    return avg;
}

async function main(): Promise<void> {
    console.log(`网关：${BASE.replace(/\/[^/]*$/, "/…")}`);
    console.log(`模型：${MODEL}\n`);

    // 预热：让 prompt 缓存与连接池先建立，避免第一次的冷启动污染对比
    console.log("预热一次…");
    await oneCall("warmup");

    console.log("\n【第 1 轮】单发，建立基线");
    const solo: number[] = [];
    for (let i = 0; i < 2; i++) {
        const r = await oneCall(`solo#${i + 1}`);
        console.log(`  ${r.tag}: ${(r.ms / 1000).toFixed(1)}s  ${r.out} tok`);
        solo.push(r.ms);
    }
    const soloAvg = solo.reduce((a, b) => a + b, 0) / solo.length;

    console.log("\n【第 2 轮】4 路并发（同时发出）");
    const t0 = Date.now();
    const parallel = await Promise.all([1, 2, 3, 4].map((i) => oneCall(`par#${i}`)));
    const wall = Date.now() - t0;
    for (const r of parallel) console.log(`  ${r.tag}: ${(r.ms / 1000).toFixed(1)}s  ${r.out} tok`);
    const parAvg = parallel.reduce((a, r) => a + r.ms, 0) / parallel.length;

    console.log("\n" + "=".repeat(64));
    console.log(`单发基线        : ${(soloAvg / 1000).toFixed(1)}s/次`);
    console.log(`4 并发时单次    : ${(parAvg / 1000).toFixed(1)}s/次`);
    console.log(`4 并发整体墙钟  : ${(wall / 1000).toFixed(1)}s`);
    console.log(`等效串行要花    : ${((soloAvg * 4) / 1000).toFixed(1)}s`);
    console.log("=".repeat(64));

    const ratio = parAvg / soloAvg;
    const speedup = (soloAvg * 4) / wall;
    console.log(`延迟退化比：${ratio.toFixed(2)}×   整体加速比：${speedup.toFixed(2)}×`);
    console.log();
    if (ratio < 1.4) {
        console.log("✅ 网关能扛并发：延迟基本不退化 → 开并行是线性提速，值得做");
    } else if (ratio < 2.2) {
        console.log("⚠️ 网关部分串行：有加速但不线性 → 并行收益打折，要算清配额账");
    } else {
        console.log("❌ 网关按账号串行：并发只是把同一个队列排得更乱 → 并行不涨墙钟，只涨复杂度");
    }
}

main().catch((e) => {
    console.error("探针失败：", (e as Error).message);
    process.exit(1);
});
