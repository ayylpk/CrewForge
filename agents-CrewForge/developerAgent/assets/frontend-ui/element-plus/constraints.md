# Element Plus 约束

- 必须在 `main.ts` 注册 Element Plus，并导入 `element-plus/dist/index.css` 或按需样式。
- 组件只能在 Vue 3 项目中使用，不能混入 Vue 2 API。
- 表单必须处理 loading、校验失败和提交成功状态。
- 表格必须处理 loading、空数据和请求错误状态。
- 不要同时引入另一套 UI 组件库解决同一类控件。
- 不把 Element Plus 组件 API 当作后端 Contract；请求字段仍以 Contract 为准。
