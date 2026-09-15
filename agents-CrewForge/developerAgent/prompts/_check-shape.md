# 判据机器字段口径（共享节）

> 本节由代码拼接进**蓝图**与**批次**两阶段提示词（prompts/_check-shape.md 单一来源），
> 是 acceptanceChecks / checks 全部形状的唯一口径。蓝图阶段只用得到形状 A（底线
> COMPILE），读完再动手不吃亏——批次阶段的判据同样服从这里的规矩。

## acceptanceChecks（验收判据）

**总原则：判据是给机器执行的，不是给人读的。** 凡是"要检查什么"的心智，都必须
落到下面的**机器字段**上（`body` / `assertJson` / `setup` / `headers` / `resetPaths`）；
写在 `expected` 里的散文只是备注，**不会被执行**——把关键约束只写在散文里
等于没写（历史教训：判据说明里写"测试前清空数据库"，但没有任何字段真的清）。

### 形状 A：编译/构建类

```json
{ "id": "ac-N", "kind": "COMPILE", "target": "backend" }
```

### 形状 B：接口契约类（基础）

```json
{ "id": "ac-N", "kind": "CONTRACT", "method": "GET", "path": "/api/xxx",
  "expectedStatus": 200, "expected": "<一句话备注>" }
```

- 要发请求体就加 `"body": { ... }`（POST/PUT/PATCH 必须给，否则服务端收空对象）；
- expectedStatus 只能写需求明示或行业惯例的码（REST 成功=200/201，参数错=400，
  不存在=404）；**不发明需求里没有的验收条件**。

### 形状 B 的四个增强字段（能用就必须用，别退回散文）

1. **`assertJson`（结构化断言）——判"返回体内容对不对"的唯一可信方式。**
   `expected` 里写"data 是数组且每项含 id"是散文；写成断言才是机器可执行。
   数组每条断言恰好给一种判定：
   ```json
   "assertJson": [
     { "path": "data", "minLength": 1 },
     { "path": "data", "each": { "path": "status", "equals": "active" } },
     { "path": "data.total", "equals": 123.45 },
     { "path": "data.0.secret", "exists": false }
   ]
   ```
   判定词：`exists`（true/false，false 用于"不该出现"）、`equals`（深等）、
   `notEquals`、`contains`、`matches`（**正则字符串**，日期/前缀过滤类只能用它）、
   `length` / `minLength`、`each: { path, equals | matches }`（数组**每一项**都满足）。
   ⚠️ `each` 对空数组恒过——过滤类判据要配 `minLength` 一起用。

2. **`setup`（前置步骤）——"先造数据再断言"的机器表达。**
   需要"先创建、再查询/筛选/删除"才能验的接口，前置写在这里（按序真执行，
   任一前置失败整条判据即失败）。用 `extract` 把上一步响应的值存进变量池，
   后续步骤与主请求的 `path`/`body`/**`headers`** 里用 `{name}` 引用：
   ```json
   "setup": [
     { "method": "POST", "path": "/api/items", "body": { "title": "样例" }, "expectedStatus": 201,
       "extract": { "name": "id", "from": "data.id" } }
   ],
   "path": "/api/items/{id}"
   ```
   ⚠️ 凡是"依赖已存在数据"的判据（筛选/汇总/按 id 操作），**必须**用 setup 自己造，
   不假设前面别的判据跑过——判据之间不保证顺序与副作用。

3. **`headers`（自定义请求头）——身份/权限类判据的表达方式。**
   引擎不认识任何头名的含义，只负责如实发送；怎么用完全由需求决定。
   适配多身份场景（"B 不能读 A 的私密资源"）：A 的身份放 setup 步骤的头里，
   B 的身份放主请求的头里：
   ```json
   "headers": { "X-User-Id": "2" },
   "setup": [ { "method": "POST", "path": "/api/projects", "body": { "private": true },
                "expectedStatus": 201, "headers": { "X-User-Id": "1" },
                "extract": { "name": "pid", "from": "data.id" } } ],
   "path": "/api/projects/{pid}", "expectedStatus": 403
   ```
   ⚠️ 需求里用什么头（如 `X-User-Id`）、谁是谁，照需求写；需求没提身份方式就先
   在 developerInstructions 里写明你的假设。

4. **`resetPaths`（干净起点）——精确断言的前提。**
   判据依赖"库里没有上一轮残留"时（"创建后 id 为 1""汇总恰为某值"），
   在判据上声明要删的数据文件（相对 **serveCwd**，即后端服务的运行目录；
   也可从项目根写全路径）：
   ```json
   "resetPaths": ["data/app.db"]
   ```
   不写这个字段的判据**跑在上一轮的数据上**——精确断言会因累积数据失败。

### 数量与强度

- 至少 1 条 COMPILE（每个被声明的 target 一条）+ 每个核心接口 1 条 CONTRACT；
- 核心业务接口的判据要**力求能证伪**：能加 assertJson 就别只写 expectedStatus；
  过滤/权限/汇总类语义**必须**用 assertJson + setup（只断状态码会假绿）；
- 判据必须能**机器执行**：写"页面美观"这种无法判定的句子等于没写。
