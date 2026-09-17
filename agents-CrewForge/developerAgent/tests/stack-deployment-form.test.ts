// ============================================================
// tests/stack-deployment-form.test.ts —— 部署形态族（R3）+ 代码级钉死（TASK2）+ 迁移自举（R8）
//
//   为什么要有这个文件：这三件事都是**静默缺陷**，上游任何闸门都看不见它们：
//     · R3：需求原文写「不引入外部服务，数据库用嵌入式的即可」，架构师 stack 里 type = "MySQL 8"——
//           旧闸门只认命名系别（SQLite/MySQL/PostgreSQL/MongoDB），"嵌入式/无外部服务"这种
//           朴素语言约束一个字都看不见，硬冲突整链放行（a1 实弹）；
//     · R8：ddl.sql 落了盘但全项目没人执行它——后端起来了表不存在，HTTP 检查集体 500，
//           而"编译过了、文件都在"看起来一切正常。
//   真项目上复现这两件事要跑完整生成流程，所以这里用**事故原文 + 最小产物树**把
//   全部分支钉死（含"不许误杀"的保守分支），否则等于没验证。
//
//   覆盖：
//     ① a1 事故原文（需求「不引入外部服务/嵌入式」+ 决策「MySQL 8」）→ 冲突，话术同时点名两侧；
//     ② 需求只提 MySQL（没有嵌入式约束）+ 决策 MySQL → 不判（约束不明确）；
//     ③ 需求嵌入式 + 决策 SQLite/H2 → 不判（决策本身就在嵌入式形态里）；
//     ④ 英文/一键启动等变体 + 保守不触发（命名系别行为逐字不变）；
//     ⑤ 决策侧否定词守卫：a1 的 why 写了"不引入…Redis 等中间件"，Redis 不许被当成偏向；
//     ⑥ pinEmbeddedDatabase：嵌入式约束 → sqlite（含迁移路径），其余 → null；
//     ⑦ checkMigrationBootstrap：读了就有（applied）/ 没人执行（not-applied）/ 拿不准（undecided，不误杀）。
// ============================================================

import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    checkMigrationBootstrap,
    checkStackConsistency,
    detectDeploymentFormConflict,
    EMBEDDED_DB_MIGRATION_FILE,
    matchDeploymentConstraint,
    pinEmbeddedDatabase,
} from "../../checkers";

// ---------- 临时产物树（os.tmpdir，测试结束统一清理） ----------

const tmpDirs: string[] = [];

/** 在临时目录里铺出给定相对路径 → 内容，返回项目根绝对路径 */
function fixture(files: Record<string, string>, prefix = "crewforge-stack-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf-8");
    }
    return dir;
}

afterAll(() => {
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无所谓 */ }
    }
});

// ============================================================
// ① 事故原文（逐字取自真实产物，不是造的例子）
// ============================================================

/** a1 冻结需求原文（eval/scenarios/a1/input.md 的"交付约束"与"边界"两段） */
const A1_REQUIREMENT = [
    "# 项目需求：团队投票决策平台（quick-poll，中型全栈项目）",
    "> 冻结输入。技术选型、UI 框架、配色布局由你决定——",
    "> 交付约束：前后端都要能用 npm 一键安装/启动/构建（Node 生态）。",
    "## 边界（本期不做）",
    "- 不做登录/注册/账号体系；不做实时推送（前端轮询即可）；不做多语言；",
    "- 不引入外部服务，数据库用嵌入式的即可；最小时间粒度到分钟。",
].join("\n");

/** a1 实际落库的栈决策（artifacts/p32/.architect-state.json：techniques.database.type + why 拼接） */
const A1_DECISION = [
    "MySQL 8",
    "本阶段数据模型为「投票-选项-投票记录」关系结构，且重复投票校验依赖 (poll_id, voter_name) 唯一约束、"
        + "选项文本校验依赖 (poll_id, option_text) 唯一约束，关系型数据库的唯一索引可把业务规则下沉到存储层兜底；"
        + "MySQL 8 的 DATETIME 精度足以承载 ISO 日期时间截止时刻的精确比较。",
    "本阶段无登录、无异步任务、无缓存需求，因此不引入 JWT 认证、消息队列、Redis 等中间件，避免无谓堆叠。",
].join("\n");

describe("部署形态族 / a1 事故（R3）", () => {
    it("需求「不引入外部服务，数据库用嵌入式的即可」+ 决策「MySQL 8」→ 报冲突", () => {
        const r = checkStackConsistency(A1_REQUIREMENT, A1_DECISION);
        expect(r.length).toBe(1);                       // 命名系别表在这里本来就看不见（需求没写库名）
        const msg = r[0] ?? "";
        expect(msg).toContain("部署形态冲突");
        expect(msg).toContain("不引入外部服务");        // 需求侧原文（引用给模型对照）
        expect(msg).toContain("嵌入式");
        expect(msg).toContain("MySQL");                 // 冒犯的选项
        expect(msg).toContain("SQLite");                // 该选什么
        expect(msg).toContain("R3");
    });

    it("决策侧的否定词守卫：why 里的「不引入…Redis 等中间件」不许被当成选型偏向", () => {
        const r = checkStackConsistency(A1_REQUIREMENT, A1_DECISION);
        expect(r.some(m => m.includes("Redis"))).toBe(false);
        expect(detectDeploymentFormConflict(A1_REQUIREMENT, A1_DECISION)).not.toBeNull();
    });

    it("detectDeploymentFormConflict 是单纯的纯函数（可脱离闸门单测）", () => {
        const c = detectDeploymentFormConflict(A1_REQUIREMENT, A1_DECISION);
        expect(c?.kind).toBe("deployment-form");
        expect(c?.detail).toContain("MySQL");
        expect(c?.detail).toContain("SQLite");   // 话术必须给"该改哪个"，不然重选还是瞎猜
        expect(detectDeploymentFormConflict(A1_DECISION, A1_REQUIREMENT)).toBeNull();  // 方向反过来不该报
    });

    it("约束识别：命中类别与原文片段都要能摘出来", () => {
        const m = matchDeploymentConstraint(A1_REQUIREMENT);
        expect(m?.label).toBe("不引入外部服务");
        expect(m?.fragment).toContain("不引入外部服务");
        expect(m?.fragment).toContain("嵌入式");
        expect(m?.index).toBeGreaterThan(0);
    });

    it("同一输入连判两次结果一致（闸门不许有隐藏状态）", () => {
        expect(checkStackConsistency(A1_REQUIREMENT, A1_DECISION)).toEqual(checkStackConsistency(A1_REQUIREMENT, A1_DECISION));
    });
});

// ============================================================
// ② 保守不触发：约束不明确就一律放行（宁漏不误杀）
// ============================================================

describe("部署形态族 / 不误杀", () => {
    it("需求点名 MySQL、决策也是 MySQL → 不判（没有嵌入式约束）", () => {
        expect(checkStackConsistency("数据库用 MySQL 8 存用户与订单", "MySQL 8")).toEqual([]);
        expect(detectDeploymentFormConflict("数据库用 MySQL 8 存用户与订单", "MySQL 8")).toBeNull();
    });

    it("需求只提「数据库」没说嵌入式/无外部服务 → 不判", () => {
        expect(detectDeploymentFormConflict("用关系型数据库，靠唯一索引兜住重复投票", "MySQL 8 + Redis 缓存")).toBeNull();
        expect(matchDeploymentConstraint("用关系型数据库，靠唯一索引兜住重复投票")).toBeNull();
    });

    it("需求嵌入式 + 决策 SQLite/H2 → 不判（决策本身就在嵌入式形态里）", () => {
        expect(checkStackConsistency("不引入外部服务，数据库用嵌入式的即可", "SQLite（better-sqlite3）")).toEqual([]);
        expect(checkStackConsistency("不引入外部服务，数据库用嵌入式的即可", "H2 内存数据库（spring.sql.init 建表）")).toEqual([]);
        expect(detectDeploymentFormConflict("不引入外部服务", "本地 sqlite 文件 + 单文件数据库")).toBeNull();
    });

    it("决策只提到被否定的外部服务（「无需 Docker / 不引入 Redis」）→ 不判", () => {
        expect(detectDeploymentFormConflict("不引入外部服务，数据库用嵌入式的即可", "better-sqlite3 落本地文件，无需 Docker，不引入 Redis")).toBeNull();
        expect(detectDeploymentFormConflict("不引入外部服务", "全部本地实现，不引入 Redis 与 Kafka")).toBeNull();
    });

    it("转折词之后的外部服务仍然算偏向（「不引入 Redis，但数据库用 MySQL」）", () => {
        const c = detectDeploymentFormConflict("不引入外部服务，数据库用嵌入式的即可", "不引入 Redis 缓存，但数据库用 MySQL 8");
        expect(c).not.toBeNull();
        // 冒犯选项只列 MySQL：Redis 在"不引入"分句里被守卫剔除（片段引用可以含 Redis，点名清单不许含）
        expect(c?.detail).toContain("而选型选了外部服务 MySQL（");
        expect(c?.detail).toContain("SQLite");
    });

    it("空需求 / 「未指定」 → 放行", () => {
        expect(checkStackConsistency("", "MySQL 8")).toEqual([]);
        expect(checkStackConsistency("未指定", "MySQL 8")).toEqual([]);
        expect(matchDeploymentConstraint("")).toBeNull();
        expect(detectDeploymentFormConflict("", "MySQL")).toBeNull();
    });
});

// ============================================================
// ③ 英文/其它变体 + 既有命名系别行为逐字不变
// ============================================================

describe("部署形态族 / 变体与回归", () => {
    it("英文约束 no external services / embedded database → 报冲突", () => {
        const c = detectDeploymentFormConflict(
            "The backend must run with no external services and use an embedded database.",
            "Database: PostgreSQL 16, started via docker-compose",
        );
        expect(c?.kind).toBe("deployment-form");
        expect(c?.detail).toContain("PostgreSQL");
        expect(c?.detail).toContain("SQLite");
        expect(detectDeploymentFormConflict("Use an embedded database.", "SQLite file db/app.db")).toBeNull();
    });

    it("一键启动 / 开箱即用 + 外部服务（Docker/Redis）→ 报冲突", () => {
        const c = detectDeploymentFormConflict("要求 npm 一键启动，开箱即用", "Docker Compose 拉起 Redis + MySQL");
        expect(c?.detail).toContain("Docker");
        expect(c?.detail).toContain("一键启动");
    });

    it("需求写明 SQLite + 决策 MySQL → 命名系别与部署形态两条都在讲真话", () => {
        const r = checkStackConsistency("技术栈：SQLite（嵌入式，不引入外部服务）", "MySQL 8");
        expect(r.some(m => m.includes("需求声明 SQLite"))).toBe(true);          // 命名系别（旧行为）
        expect(r.some(m => m.includes("部署形态冲突"))).toBe(true);             // 部署形态（新增）
    });

    it("既有命名系别话术逐字不变（s4 实弹：需求 Node+Express+SQLite，选了 Spring Boot）", () => {
        expect(checkStackConsistency("Tech: Node + Express + SQLite", "Spring Boot 3 + sqlite-jdbc"))
            .toEqual(["需求声明 Node 系，而选型偏向 Spring/JVM；回到需求原文重新选型"]);
    });
});

// ============================================================
// ④ TASK2：代码级钉死（不靠模型自觉）
// ============================================================

describe("嵌入式约束下的数据库钉死（TASK2）", () => {
    it("嵌入式约束 → 钉死 sqlite + 迁移文件路径 + 可读理由", () => {
        const pinned = pinEmbeddedDatabase(A1_REQUIREMENT);
        expect(pinned).not.toBeNull();
        expect(pinned?.type).toBe("sqlite");
        expect(pinned?.migrationFile).toBe(EMBEDDED_DB_MIGRATION_FILE);
        expect(pinned?.why).toContain("sqlite");
        expect(pinned?.why).toContain("不引入外部服务");       // 理由必须挂回需求原文，模型才服
        expect(pinned?.why).toContain(EMBEDDED_DB_MIGRATION_FILE);
    });

    it("约束不明确 → 返回 null（不干预选型）", () => {
        expect(pinEmbeddedDatabase("数据库用 MySQL 8 存用户与订单")).toBeNull();
        expect(pinEmbeddedDatabase("未指定")).toBeNull();
        expect(pinEmbeddedDatabase("")).toBeNull();
    });

    it("允许调用方覆盖迁移文件（Spring 骨架走 classpath:schema.sql）", () => {
        const pinned = pinEmbeddedDatabase("不引入外部服务，数据库用嵌入式的即可", "backend/src/main/resources/schema.sql");
        expect(pinned?.type).toBe("sqlite");
        expect(pinned?.migrationFile).toBe("backend/src/main/resources/schema.sql");
        expect(pinned?.why).toContain("backend/src/main/resources/schema.sql");
    });

    it("纯函数：同一输入两次结果一致", () => {
        expect(pinEmbeddedDatabase(A1_REQUIREMENT)).toEqual(pinEmbeddedDatabase(A1_REQUIREMENT));
    });
});

// ============================================================
// ⑤ TASK3：迁移自举（R8）—— 有 DDL 有没有人执行
// ============================================================

describe("迁移自举（R8）", () => {
    it("ddl 文件 + 启动时读它执行 → applied（证据带 file:line）", () => {
        const dir = fixture({
            "db/init.sql": "-- 待执行 DDL\nCREATE TABLE IF NOT EXISTS todo (\n  id INTEGER PRIMARY KEY,\n  title TEXT NOT NULL\n);\n",
            "backend/package.json": `{\n  "name": "backend",\n  "scripts": {\n    "start": "bun run src/db.ts"\n  }\n}\n`,
            "backend/src/db.ts": [
                `import fs from "node:fs";`,
                `import { Database } from "bun:sqlite";`,
                ``,
                `const db = new Database(process.env.DB_FILE ?? "data/app.db");`,
                `db.exec(fs.readFileSync(new URL("../../db/init.sql", import.meta.url), "utf-8"));`,
                ``,
                `export default db;`,
                ``,
            ].join("\n"),
        });
        const r = checkMigrationBootstrap(dir);
        expect(r.ok).toBe(true);
        expect(r.status).toBe("applied");
        expect(r.sqlFile).toBe("db/init.sql");
        expect(r.ddlAt).toBe("db/init.sql:2");
        expect(r.appliedBy).toContain("backend/src/db.ts:");
        expect(r.appliedBy).toMatch(/db\.ts:\d/);
        expect(r.note).toContain("DDL 自举正常");
    });

    it("ddl.sql 没人引用 → not-applied（R8 事故形态，ok:false）", () => {
        const dir = fixture({
            "ddl.sql": "-- 目标数据库：MySQL 8，字符集 utf8mb4\nCREATE TABLE `poll` (\n  `id` INT NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n);\n",
            "backend/package.json": `{\n  "name": "backend",\n  "version": "1.0.0",\n  "scripts": {\n    "build": "tsc -p tsconfig.json",\n    "start": "node dist/index.js"\n  }\n}\n`,
            "backend/src/index.ts": `import express from "express";\n\nconst app = express();\napp.get("/api/polls", (_req, res) => { res.json([]); });\napp.listen(Number(process.env.PORT ?? 3000));\n`,
        });
        const r = checkMigrationBootstrap(dir);
        expect(r.ok).toBe(false);
        expect(r.status).toBe("not-applied");
        expect(r.sqlFile).toBe("ddl.sql");
        expect(r.appliedBy).toBeNull();
        expect(r.ddlAt).toBe("ddl.sql:2");
        expect(r.note).toContain("Table");
        expect(r.note).toContain("ddl.sql");
        expect(r.note).toContain("db:init");             // 出路必须具体到能照做
    });

    it("空目录 → undecided（不报假缺陷）", () => {
        const dir = fixture({});
        const r = checkMigrationBootstrap(dir);
        expect(r.ok).toBe(true);
        expect(r.status).toBe("undecided");
        expect(r.sqlFile).toBeNull();
        expect(r.appliedBy).toBeNull();
        expect(r.ddlAt).toBeNull();
        expect(r.note).toMatch(/未判定/);
    });

    it("Spring：schema.sql + spring.sql.init(mode=always) → applied", () => {
        const dir = fixture({
            "backend/src/main/resources/application.yml": "spring:\n  sql:\n    init:\n      mode: always\n      schema-locations: classpath:schema.sql\n",
            "backend/src/main/resources/schema.sql": "CREATE TABLE IF NOT EXISTS poll (id INT PRIMARY KEY);\n",
        });
        const r = checkMigrationBootstrap(dir);
        expect(r.status).toBe("applied");
        expect(r.sqlFile).toBe("backend/src/main/resources/schema.sql");
        expect(r.appliedBy).toContain("application.yml:");
    });

    it("代码内联建表并执行 → applied（表建得出来，就不会撞 500）", () => {
        const dir = fixture({
            "backend/src/db.ts": [
                `import { Database } from "bun:sqlite";`,
                `const db = new Database("data/app.db");`,
                "db.exec(`",
                "  CREATE TABLE IF NOT EXISTS todo (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
                "`);",
                `export default db;`,
                ``,
            ].join("\n"),
        });
        const r = checkMigrationBootstrap(dir);
        expect(r.status).toBe("applied");
        expect(r.sqlFile).toBe("backend/src/db.ts");
        expect(r.ddlAt).toBe("backend/src/db.ts:4");
        expect(r.note).toContain("内联");
    });

    it("package.json 的 db:init 脚本点名了 ddl 文件 → applied", () => {
        const dir = fixture({
            "db/init.sql": "CREATE TABLE IF NOT EXISTS todo (id INTEGER PRIMARY KEY);\n",
            "package.json": `{\n  "name": "app",\n  "scripts": {\n    "db:init": "sqlite3 data/app.db < db/init.sql",\n    "start": "node server.js"\n  }\n}\n`,
        });
        const r = checkMigrationBootstrap(dir);
        expect(r.status).toBe("applied");
        expect(r.appliedBy).toContain("package.json:");
    });

    it("有 DDL、没人执行，但 ORM 自动建表开着 → undecided（静态判不了，不误杀）", () => {
        const dir = fixture({
            "backend/src/main/resources/application.yml": "spring:\n  jpa:\n    hibernate:\n      ddl-auto: update\n",
            "backend/src/main/resources/schema.sql": "CREATE TABLE IF NOT EXISTS poll (id INT PRIMARY KEY);\n",
        });
        const r = checkMigrationBootstrap(dir);
        expect(r.ok).toBe(true);
        expect(r.status).toBe("undecided");
        expect(r.note).toContain("ddl-auto");
    });

    it("目录不存在 → undecided 且不抛异常", () => {
        const r = checkMigrationBootstrap(path.join(os.tmpdir(), `crewforge-mig-missing-${process.pid}-${Date.now()}`));
        expect(r.ok).toBe(true);
        expect(r.status).toBe("undecided");
        expect(r.note).toMatch(/未判定/);
    });

    it("纯函数：同一产物树两次结果一致", () => {
        const dir = fixture({ "ddl.sql": "CREATE TABLE t (id INT);\n" });
        expect(checkMigrationBootstrap(dir)).toEqual(checkMigrationBootstrap(dir));
    });
});
