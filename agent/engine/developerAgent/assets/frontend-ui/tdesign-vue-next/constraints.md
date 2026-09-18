# TDesign Vue Next 约束

- 必须在 `main.ts` 注册 TDesign，并导入 `tdesign-vue-next/es/style/index.css`。
- 组件只能在 Vue 3 项目中使用，不能混入 Vue 2 API。
- 表单、表格和反馈组件必须处理 loading、empty、error 和 success 状态。
- 不要同时引入 Element Plus 解决同一类控件。
- 组件属性只负责展示和交互，接口字段仍以 Contract 为准。
- 主题色和字体应集中管理，不要在页面中散落大量内联样式。
