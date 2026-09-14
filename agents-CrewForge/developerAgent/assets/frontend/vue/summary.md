---
id: vue
kind: frontend
version: 3.5.21
runtime: Node.js 20+
provides: [frontend.spa, ui.reactive, routing.client, http.json-client]
requires: [backend.http]
recommendedFor: [management-ui, forms, CRUD, dashboard]
avoidWhen: [no-web-ui, static-content-only]
build: npm run build
preview: npm run preview
details: manifest.json
---
Vue 3、TypeScript 与 Vite 的 SPA 资产，强调明确路由、类型检查和可构建交付。
