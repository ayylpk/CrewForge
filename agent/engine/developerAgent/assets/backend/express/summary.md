---
id: express
kind: backend
version: 5.1.0
runtime: Node.js 20+
provides: [backend.http, http.rest, middleware.composable, health.http]
requires: []
recommendedFor: [small-api, BFF, CRUD, rapid-prototype]
avoidWhen: [JVM-only-environment, heavy-transaction-domain]
build: npm run build
boot: npm run start
details: manifest.json
---
轻量 TypeScript REST 后端资产，适合小型 API、BFF 和快速交付，不内置数据库绑定。
