// tests/clip-args.test.ts —— 参数字段裁剪（原 history-prune.test.ts 的第三组，**原样搬过来**）
//
//   为什么搬家：那个文件里的前两组（pruneHistory 的字符折叠）**已随机制退役**
//   （理由见 graph.ts 顶部与 contextCompaction.ts 文件头：原地改 history 中部与
//   "整份替换 + 稳定前缀"的压缩语义互相打架，且字符口径与 token 口径对不上）。
//   但同一文件里的这三条**与折叠无关**——它们钉的是 clipArgsForModel：
//   "记录里可以省略，调用本身是按完整参数执行的"这条防幻觉声明。
//   断言一字未改，只是换了文件名（跟着留下的代码走，而不是跟着搬走的代码走）。
import { describe, expect, it } from "bun:test";
import { clipArgsForModel, MODEL_ARG_FIELD_LIMIT } from "../graph";

describe("clipArgsForModel / 参数字段护栏", () => {
    it("短参数原样（路径/命令/行号这类不动）", () => {
        const args = { path: "src/a.ts", offset: 1, limit: 100, command: "npm test" };
        expect(clipArgsForModel(args)).toEqual(args);
    });

    it(`超 ${MODEL_ARG_FIELD_LIMIT} 字符的字符串字段折中段，并声明"已按完整参数执行"`, () => {
        const big = "c".repeat(20_000);
        const out = clipArgsForModel({ path: "big.vue", content: big });
        const content = out["content"] as string;
        expect(out["path"]).toBe("big.vue");
        expect(content.length).toBeLessThan(big.length);
        expect(content).toContain("中段省略");
        // 防幻觉：必须说清"只是记录省略，调用按完整参数执行过"
        expect(content).toContain("完整");
        expect(content).toContain("以磁盘为准");
    });

    it("非字符串参数（数字/布尔/对象）原样透传", () => {
        const nested = { a: 1 };
        const out = clipArgsForModel({ n: 5, flag: true, obj: nested });
        expect(out["n"]).toBe(5);
        expect(out["flag"]).toBe(true);
        expect(out["obj"]).toBe(nested);
    });
});
