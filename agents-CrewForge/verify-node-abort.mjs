// 验证 Node fetch(undici) 的 AbortSignal 是否可靠（8/13 遗留脚本）
const ac = new AbortController();
const t0 = Date.now();
setTimeout(() => ac.abort(), 100);
try {
  const res = await fetch("https://api.deepseek.com/v1/models", { signal: ac.signal });
  console.log("FAIL: 请求应在 abort 后失败(可能被服务端缓存解决)", res.status, Date.now() - t0 + "ms");
} catch (e) {
  console.log("OK: abort 生效 →", e.name, "in", Date.now() - t0 + "ms");
}
