// scripts/verify-t5.mjs —— T5 验收：日记/文件两页的契约静态断言（cwd=frontend）
// 机械检查：端点齐全、方法齐全、multipart 字段名、下载直链、tags 数组用法、无硬编码端口
import { readFileSync } from "node:fs";

const t0 = Date.now();
const die = (msg) => { console.error(`[verify-t5] FAIL: ${msg} (+${Date.now() - t0}ms)`); process.exit(1); };
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { die(`读不到 ${p}`); } };

const diary = read("src/views/DiaryList.vue");
const files = read("src/views/FileList.vue");

// —— 日记页 ——
if (!diary.includes("/api/diaries")) die("DiaryList 未调用 /api/diaries");
if (!/api\/diaries\?|api\/diaries`|api\/diaries'/.test(diary)) die("DiaryList 缺 GET 列表调用");
for (const m of ["POST", "PUT", "DELETE"]) {
    if (!new RegExp(`['"\`]${m}['"\`]`).test(diary)) die(`DiaryList 缺 method=${m}`);
}
if (!/year/.test(diary) || !/month/.test(diary)) die("DiaryList 缺 year/month 过滤状态");
if (!/confirm\s*\(/.test(diary)) die("DiaryList 删除缺 confirm");
if (!/tags/.test(diary)) die("DiaryList 未处理 tags");
console.log(`[verify-t5] DiaryList 契约断言绿`);

// —— 文件页 ——
if (!files.includes("/api/files")) die("FileList 未调用 /api/files");
if (!/FormData|formData/.test(files)) die("FileList 上传缺 FormData");
if (!/append\(\s*['"]file['"]/.test(files)) die("multipart 字段名必须是 file");
if (!/\/api\/files\/\$\{|\/api\/files\/['\"]?\s*\+|:id\/download|download`/.test(files)) die("FileList 缺 /api/files/{id}/download 直链");
if (!/DELETE/.test(files)) die("FileList 缺 DELETE");
if (!/confirm\s*\(/.test(files)) die("FileList 删除缺 confirm");
if (!/1024|KB|MB|toFixed/.test(files)) die("FileList 缺 size 格式化");
console.log(`[verify-t5] FileList 契约断言绿`);

// —— 共同红线 ——
for (const [name, src] of [["DiaryList", diary], ["FileList", files]]) {
    if (/localhost:8180|127\.0\.0\.1:8180/.test(src)) die(`${name} 硬编码了后端端口——必须走同源 /api 代理`);
}
console.log(`[verify-t5] 全部绿 (+${Date.now() - t0}ms)`);
process.exit(0);
