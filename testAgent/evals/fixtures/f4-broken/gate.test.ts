// gate.test.ts —— 部署前门禁：校验生产环境凭证是否注入
import { test, expect } from "bun:test";

test("PROD_DEPLOY_KEY 必须存在（外部部署服务连通性门禁）", () => {
  expect(process.env.PROD_DEPLOY_KEY).toBeTruthy();
});
