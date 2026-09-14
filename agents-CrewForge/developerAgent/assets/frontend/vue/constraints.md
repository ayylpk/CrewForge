# Vue 资产约束

- 使用 Vue 3 Composition API、TypeScript strict 与 Vite。
- `index.html`、`src/main.ts` 和 `/` 路由必须存在。
- API 基地址统一为 `/api`，开发代理目标通过环境变量配置。
- API 类型与字段来自 Contract 和 Domain Model，禁止页面自行发明字段。
- 不允许重复导出 API 函数，不允许重复注册同一路由。
- 页面必须处理 loading、empty、error 和 success 状态。
- 构建通过不等于页面有效，正式验证还需渲染检查。
- 不在源码中写死后端地址、令牌或密钥。
