import mysql from "mysql2/promise";

/**
 * 全项目共用的 MySQL 连接池（阶段 2 收编：原先 Node.ts / task.ts 各开一池、三处硬编码）。
 * 连接参数口径（v2 F1 拍板：DB 参数留 .env，不进 sys_settings——引擎先连库才能读表，自举死循环）：
 *   DB_HOST / DB_PORT / DB_USER / DB_NAME 可选覆盖，DB_PASSWORD 必填在 .env。
 */
export const pool = mysql.createPool({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "crewforge",
    waitForConnections: true,
    connectionLimit: 5,
});
