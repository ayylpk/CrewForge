// 探针：网关支不支持 prompt caching（cache_control: ephemeral）？
// 若支持 → 重复的 system+tools+历史可缓存复用，直接砍掉大头的 input 成本和首 token 延迟。
import { loadDotEnv } from "../dotenv";
loadDotEnv();

const baseUrl = (process.env["ANTHROPIC_BASE_URL"] ?? "").replace(/\/+$/, "");
const token = process.env["ANTHROPIC_AUTH_TOKEN"] ?? "";
const model = process.env["DEVELOPER_LLM_MODEL"] ?? "qwen3.8-flash";

// 造一段足够长的 system（缓存有最小 token 门槛，太短不会生效）
const longSystem = "你是一个严谨的编码助手。以下是项目规范：\n" +
    Array.from({ length: 120 }, (_, i) => `规则${i + 1}：所有代码必须类型安全、必须处理错误、必须写注释、必须可测试。`).join("\n");

async function call(label: string, useCache: boolean, msgs: any[]) {
    const sys: any = useCache
        ? [{ type: "text", text: longSystem, cache_control: { type: "ephemeral" } }]
        : longSystem;
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 64, system: sys, messages: msgs }),
        signal: AbortSignal.timeout(120_000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) { console.log(`[${label}] HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); return null; }
    const d = await res.json() as any;
    console.log(`[${label}] ${ms}ms  usage=${JSON.stringify(d.usage)}`);
    return d.usage;
}

const msg = [{ role: "user", content: "回复两个字：收到" }];
console.log("=== 第 1 次带 cache_control（期望 cache_creation > 0）===");
await call("cache#1", true, msg);
console.log("=== 第 2 次相同前缀（期望 cache_read > 0）===");
await call("cache#2", true, msg);
console.log("=== 对照组：不带 cache_control ===");
await call("nocache", false, msg);
