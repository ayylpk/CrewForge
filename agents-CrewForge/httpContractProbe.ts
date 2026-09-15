// ============================================================
// httpContractProbe.ts —— 通用 HTTP 契约探针（**CLI 薄壳**）
//
//   存在意义：testAgent --verify 只执行**显式命令**判据（不猜命令、不内置 HTTP 语义）。
//   CONTRACT 意图由 hub-runner 的验收站翻译成一条命令：
//     bun run httpContractProbe.ts --serve '<ServeSpec JSON>' --intent '<Intent JSON>'
//   本脚本自己起服务（随机端口）→ 打真请求 → 断言 → 杀服务 → 用退出码说话。
//   栈无关：只认 method/path/expectedStatus/body/expectBodyContains/auth（登录前置取
//   token 发 Bearer）；服务怎么起，全在 --serve 里声明。
//
//   ★ 9/15 下沉改造：执行核已提取到 ./contractProbeCore.ts（可导入函数），
//     本文件只剩"解析参数 → 调核 → 翻译退出码"。这样 Developer 侧的
//     runAcceptance 工具与 hub-runner 的 CLI 走**同一份**执行逻辑，
//     不会出现"两条路径行为不一致"——r5 的验收通道断裂（verifier 把 CONTRACT
//     登记为 skipped，模型只能手写 selftest-*.mjs 自证）就是这么来的。
//
//   退出码：0=契约通过；1=不过/起不来/断言失败（stdout 给人看的现场，stderr 给证据链）。
// ============================================================

import { runContractProbe } from "./contractProbeCore";
import type { ContractIntent, ServeSpec } from "./contractProbeCore";

function argOf(flag: string): string | null {
    const i = process.argv.indexOf(flag);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const serveRaw = argOf("--serve");
const intentRaw = argOf("--intent");
if (!serveRaw || !intentRaw) {
    console.error("用法: bun run httpContractProbe.ts --serve '<json ServeSpec>' --intent '<json Intent>'");
    process.exit(1);
}
let serve: ServeSpec, intent: ContractIntent;
try {
    serve = JSON.parse(serveRaw);
    intent = JSON.parse(intentRaw);
} catch (e) {
    console.error(`--serve/--intent 不是合法 JSON：${(e as Error).message}`);
    process.exit(1);
}

// CLI 的 cwd 就是验收检查的 cwd；探针据此解析 serve.cwd（相对路径）
const result = await runContractProbe({
    projectDirAbs: process.cwd(),
    serve,
    intent,
    log: (line) => console.log(line),
});

if (result.ok) {
    process.exit(0);
}
// 失败：人可读现场进 stderr（hub-runner 的 verify 会连同 stdout 一起当证据收）
console.error(result.output);
process.exit(1);
