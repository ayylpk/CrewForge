// scripts/verify-t4.mjs —— T4 验收：视觉契约静态断言（cwd=frontend）
// 只读 src 文件做机械检查：路由齐全 / 视觉基线关键词 / 无外链图片 / main.ts 挂样式
import { readFileSync, existsSync } from "node:fs";

const t0 = Date.now();
const die = (msg) => { console.error(`[verify-t4] FAIL: ${msg} (+${Date.now() - t0}ms)`); process.exit(1); };
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { die(`读不到 ${p}`); } };

// ① 四个视图文件存在
const views = {
    home: "src/views/Home.vue",
    projects: "src/views/ProjectList.vue",
    diary: "src/views/DiaryList.vue",
    files: "src/views/FileList.vue",
};
for (const [name, p] of Object.entries(views)) {
    if (!existsSync(p)) die(`缺视图 ${name} → ${p}`);
}
console.log(`[verify-t4] 4 视图文件齐`);

// ② 路由：'/' 指向 Home（不再是 ProjectList），且 /projects /diary /files 都在
const router = read("src/router/index.ts");
for (const path of ["/projects", "/diary", "/files"]) {
    if (!router.includes(path)) die(`router 缺 ${path}`);
}
if (!/Home(\.vue)?/.test(router)) die("router 没接 Home");
if (!router.includes("/diary") || !/DiaryList/.test(router)) die("/diary 未指向 DiaryList");
if (!/FileList/.test(router)) die("/files 未指向 FileList");
console.log(`[verify-t4] 路由齐全（/ → Home + 三模块）`);

// ③ Home.vue 视觉基线：天空渐变 + 太阳 + 草地色，且不许外链图片
const home = read(views.home);
if (!/linear-gradient/.test(home)) die("Home 缺 linear-gradient（天空）");
if (!/radial-gradient/.test(home)) die("Home 缺 radial-gradient（太阳）");
if (!/#7c[ea]|grass|草地|#7ec8|#76b852|#8bc34a|#6ab04c/i.test(home)) die("Home 找不到草地色线索");
if (/https?:\/\/\S+\.(png|jpe?g|gif|svg|webp)/i.test(home)) die("Home 引了外链图片——本任务要求纯 CSS");
if (!/router-link|router\.push|\$router/.test(home)) die("Home 缺模块入口跳转");
console.log(`[verify-t4] Home 视觉基线 OK（纯 CSS）`);

// ④ 全局样式挂接 + 导航
const main = read("src/main.ts");
if (!/theme\.css|styles/.test(main)) die("main.ts 未引入全局主题样式");
// ★ 9/13 血泪：views/router 曾是死代码（main 不装 router，build 照样绿）。
// 静态检查必须看"可达性"：router 文件存在 → main.ts 必须 import+use。
const routerFile = read("src/router/index.ts");
if (!/import\s+router|from ['"]\.\/router/.test(main) || !/\.use\(\s*router\s*\)/.test(main)) {
    die("main.ts 未安装 router（import 或 .use(router) 缺失）——所有 router-link 将渲染为死文本");
}
if (!/createWebHistory|createWebHashHistory/.test(routerFile)) die("router/index.ts 缺 history 模式");
const pkg = read("package.json");
if (/from ['"]vue-router/.test(main + routerFile) && !/"vue-router"/.test(pkg)) die("代码引用 vue-router 但 package.json 无此依赖");
if (!/vue-router/.test(readFileSync("package-lock.json", "utf8").slice(0, 3000))) {
    // lock 里要有（装了才算装）
    if (!existsSync("node_modules/vue-router")) die("node_modules 里没有 vue-router——npm install 没跑");
}
const app = read("src/App.vue");
const navOk = /nav|header|menu/i.test(app) && /router-link/.test(app);
if (!navOk) die("App.vue 缺全局导航（router-link）");
console.log(`[verify-t4] main.ts 样式挂接 + App 导航 OK`);

// ⑤ title
const html = read("index.html");
if (!/mysite|小站/i.test(html)) die("index.html title 未按契约改");
console.log(`[verify-t4] 全部静态断言绿 (+${Date.now() - t0}ms)`);
process.exit(0);
