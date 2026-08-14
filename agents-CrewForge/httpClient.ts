import { Client } from "undici";

export interface JsonRequestOptions {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    connectTimeoutMs?: number;
    headersTimeoutMs?: number;
    bodyTimeoutMs?: number;
}

export interface JsonResponse<T> {
    statusCode: number;
    body: T;
}

// Each call owns its Client. A timed-out request therefore cannot poison a
// shared pool used by later Agent calls.
export async function requestJson<T>(
    origin: string,
    path: string,
    options: JsonRequestOptions,
): Promise<JsonResponse<T>> {
    const client = new Client(origin, {
        connectTimeout: options.connectTimeoutMs ?? Math.min(options.timeoutMs, 10_000),
        headersTimeout: options.headersTimeoutMs ?? options.timeoutMs,
        bodyTimeout: options.bodyTimeoutMs ?? options.timeoutMs,
    });

    let timeoutError: Error | undefined;
    let failed = false;
    const abortRequest = () => client.destroy(new Error("HTTP 请求已取消"));
    options.signal?.addEventListener("abort", abortRequest, { once: true });
    if (options.signal?.aborted) abortRequest();
    const timer = setTimeout(() => {
        timeoutError = new Error(`HTTP 请求超时 ${Math.round(options.timeoutMs / 1000)}s`);
        client.destroy(timeoutError);
    }, options.timeoutMs);

    try {
        const response = await client.request({
            path,
            method: options.method,
            headers: options.headers,
            body: options.body,
        });
        const text = await response.body.text();
        return {
            statusCode: response.statusCode,
            body: JSON.parse(text) as T,
        };
    } catch (error) {
        failed = true;
        if (timeoutError) throw timeoutError;
        throw error;
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abortRequest);
        if (failed || timeoutError) {
            client.destroy(timeoutError);
        } else {
            await client.close().catch(() => client.destroy());
        }
    }
}
