// tools/httpRequest.ts —— 本机 HTTP 调试（Claude Code 式）
//
//   为什么需要它：Developer 起了本地服务之后要自己打接口看真实响应，
//   而不是靠"我觉得应该返回 200"。所以它必须是**真**请求，不是模拟。
//
//   边界（规格二.2）：默认只允许 localhost / 127.0.0.1 / ::1，
//   由 processSandbox 的 networkPolicy 裁决（部署方可显式放开）。
//   请求本身在 Developer 进程内发出（不是子进程），但同样要求沙箱可用——
//   否则真实模式下"沙箱不可用"这条闸就形同虚设。
import { num, str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

export const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"] as const;

/** 解析并裁决 URL：只接受 http/https，且 host 必须过网络策略 */
export function parseTarget(url: string): { ok: true; url: URL } | { ok: false; reason: string } {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return { ok: false, reason: `不是合法 URL：${url}` };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, reason: `只支持 http/https，收到 ${u.protocol}` };
    }
    return { ok: true, url: u };
}

export const httpRequestTool: ToolSpec = {
    name: "httpRequest",
    description: "发起真实 HTTP 请求（GET/POST/PUT/DELETE/PATCH/HEAD），默认只允许 localhost / 127.0.0.1 / ::1。返回状态码、响应头、响应体与耗时。",
    parameters: {
        url: { type: "string", required: true, description: "完整 URL，如 http://127.0.0.1:8080/api/notes" },
        method: { type: "string", required: false, description: "GET | POST | PUT | DELETE | PATCH | HEAD，默认 GET" },
        headers: { type: "object", required: false, description: "请求头键值对" },
        body: { type: "string", required: false, description: "请求体（字符串；对象请自行 JSON.stringify）" },
        timeoutMs: { type: "number", required: false, description: "超时毫秒数，默认 30000" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const rawUrl = str(args, "url");
        if (!rawUrl) return { ok: false, output: "url 不能为空" };

        const parsed = parseTarget(rawUrl);
        if (!parsed.ok) {
            return {
                ok: false, output: parsed.reason,
                rejected: { code: "NETWORK_DENIED", target: rawUrl, message: parsed.reason },
            };
        }
        const method = (str(args, "method") || "GET").toUpperCase();
        if (!(HTTP_METHODS as readonly string[]).includes(method)) {
            return { ok: false, output: `method 不支持：${method}（可选 ${HTTP_METHODS.join(" | ")}）` };
        }

        // 网络策略：默认只放行本机回环
        const verdict = ctx.workspace.sandbox.checkNetwork(parsed.url.hostname);
        if (!verdict.ok) {
            return {
                ok: false, output: verdict.reason ?? "网络策略拒绝",
                rejected: { code: "NETWORK_DENIED", target: parsed.url.host, message: verdict.reason ?? "网络策略拒绝" },
            };
        }
        // 没有可用隔离后端时，真实模式不该有任何执行口
        try {
            ctx.workspace.sandbox.assertAvailable();
        } catch (e) {
            return {
                ok: false, output: (e as Error).message,
                rejected: { code: "SANDBOX_UNAVAILABLE", target: rawUrl, message: (e as Error).message },
            };
        }

        const caps = ctx.workspace.sandboxCapabilities;
        const isolation = {
            realIsolation: caps.realIsolation,
            softIsolation: caps.softIsolation,
            sandboxMode: caps.mode,
            sandboxBackend: caps.backend,
        };

        const timeoutMs = num(args, "timeoutMs", 30_000);
        const headers = (args["headers"] && typeof args["headers"] === "object" && !Array.isArray(args["headers"]))
            ? args["headers"] as Record<string, string>
            : undefined;
        const body = str(args, "body");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const started = Date.now();

        try {
            const res = await fetch(parsed.url, {
                method,
                ...(headers ? { headers } : {}),
                ...(method === "GET" || method === "HEAD" || !body ? {} : { body }),
                signal: controller.signal,
                redirect: "manual",
            });
            const text = await res.text();
            const durationMs = Date.now() - started;
            const head = `$ HTTP ${method} ${parsed.url.toString()} → ${res.status} ${res.statusText} (${durationMs}ms)`;
            const headerLines = [...res.headers.entries()].map(([k, v]) => `  ${k}: ${v}`);
            return {
                ok: res.status >= 200 && res.status < 400,
                output: [head, ...headerLines, "", text.slice(0, 20_000)].join("\n"),
                meta: {
                    url: parsed.url.toString(), method, status: res.status, statusText: res.statusText,
                    durationMs, headers: Object.fromEntries(res.headers.entries()),
                    bodyBytes: Buffer.byteLength(text, "utf-8"),
                    ...isolation,
                },
            };
        } catch (e) {
            const durationMs = Date.now() - started;
            const aborted = (e as Error).name === "AbortError";
            return {
                ok: false,
                output: `$ HTTP ${method} ${parsed.url.toString()} → ${aborted ? `超时（${timeoutMs}ms）` : `失败：${(e as Error).message}`} (${durationMs}ms)`,
                meta: { url: parsed.url.toString(), method, status: null, durationMs, timedOut: aborted, ...isolation },
            };
        } finally {
            clearTimeout(timer);
        }
    },
};
