# Express 资产约束

- 使用 Node.js 20+、Express 5 和 TypeScript strict。
- 生产启动必须运行编译后的 `dist/src/index.js`，不能用 ts-node 作为生产入口。
- 路由、配置、中间件和启动入口分文件维护。
- 所有异步路由错误必须进入统一错误处理中间件。
- `/health` 必须返回 HTTP 200 和可机器读取的状态。
- 端口只能通过 `PORT` 环境变量配置，不能写死部署端口。
- 数据库驱动不内置；由独立 database 资产通过扩展点注入。
- 不得把请求体、令牌或密码写入日志。
