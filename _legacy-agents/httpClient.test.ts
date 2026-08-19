import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { requestJson } from "./httpClient.ts";

let server: Server;
let origin: string;
let hangingSocketClosed = false;

before(async () => {
    server = createServer((request, response) => {
        if (request.url === "/hang") {
            request.socket.once("close", () => {
                hangingSocketClosed = true;
            });
            return;
        }

        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    server.close();
    await once(server, "close");
});

test("destroys a timed-out client and allows the next request to complete", async () => {
    await assert.rejects(
        requestJson(origin, "/hang", {
            method: "GET",
            timeoutMs: 50,
        }),
        /HTTP 请求超时 0s/,
    );

    await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1_000;
        const poll = () => {
            if (hangingSocketClosed) return resolve();
            if (Date.now() >= deadline) return reject(new Error("timed-out client socket was not closed"));
            setTimeout(poll, 10);
        };
        poll();
    });

    const response = await requestJson<{ ok: boolean }>(origin, "/ok", {
        method: "GET",
        timeoutMs: 500,
    });
    assert.deepEqual(response.body, { ok: true });
});

test("destroys a client when its AbortSignal is cancelled", async () => {
    let abortedSocketClosed = false;
    const abortServer = createServer((request) => {
        request.socket.once("close", () => {
            abortedSocketClosed = true;
        });
    });
    abortServer.listen(0, "127.0.0.1");
    await once(abortServer, "listening");
    const address = abortServer.address();
    assert(address && typeof address !== "string");

    const controller = new AbortController();
    const requestPromise = requestJson(`http://127.0.0.1:${address.port}`, "/abort", {
        method: "GET",
        timeoutMs: 1_000,
        signal: controller.signal,
    });
    await once(abortServer, "request");
    controller.abort();

    await assert.rejects(requestPromise);
    await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1_000;
        const poll = () => {
            if (abortedSocketClosed) return resolve();
            if (Date.now() >= deadline) return reject(new Error("aborted client socket was not closed"));
            setTimeout(poll, 10);
        };
        poll();
    });

    abortServer.close();
    await once(abortServer, "close");
});
