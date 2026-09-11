// ============================================================
// java-gate-smoke.ts —— Java 闸门接线冒烟（零 LLM）
//
//   验证 checkers.checkFile / checkBatch 对 .java 的接线：
//     ① 单文件：坏码必拒、好码零误杀、中文注释零编码误报
//     ② 文件名保真：public class 与文件名不符 → 必拒（临时文件按原始相对路径还原才抓得到）
//     ③ 批量：一次 javac 整批，诊断**按文件正确归因**（不许互相串台）
//     ④ 不误伤：非 Java 文件不受影响
// ============================================================

import { checkFile, checkBatch, buildKnown } from "../../../checkers";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}

const KNOWN = buildKnown(null);

const GOOD = `package com.demo;
import java.util.List;
public class AccountService {
    public int count(List<String> xs) { return xs.size(); }
}
`;

const BAD_SYNTAX = `package com.demo;
public class AccountService {
    public void run() {
        int x = 1
        if (x > 0) { System.out.println(x); }
    }
}
`;

const CN_COMMENT = `package com.demo;
/** 账号服务：管理员开通账号并生成激活码 */
public class AccountService {
    public String hi() { return "好"; }
}
`;

const NAME_MISMATCH = `package com.demo;
public class SomethingElse {
    public String hi() { return "x"; }
}
`;

const DEPS_ONLY = `package com.demo;
import org.springframework.stereotype.Service;
@Service
public class AccountService {
    public String hi() { return "x"; }
}
`;

async function main(): Promise<void> {
    console.log("=== ① 单文件闸门 ===");
    const pGood = await checkFile("backend/src/main/java/com/demo/AccountService.java", GOOD, KNOWN);
    ok(pGood.length === 0, `好码零误杀（问题 ${pGood.length} 条）`);

    const pBad = await checkFile("backend/src/main/java/com/demo/AccountService.java", BAD_SYNTAX, KNOWN);
    ok(pBad.length > 0, `坏码必拒（捕获 ${pBad.length} 条）`);
    ok(pBad.some(p => p.includes("AccountService.java:")), "诊断带文件名与行号（可直接进自修 feedback）");

    const pCn = await checkFile("backend/src/main/java/com/demo/AccountService.java", CN_COMMENT, KNOWN);
    ok(pCn.length === 0, `★ UTF-8 中文注释零编码误报（问题 ${pCn.length} 条）`);

    const pDeps = await checkFile("backend/src/main/java/com/demo/AccountService.java", DEPS_ONLY, KNOWN);
    ok(pDeps.length === 0, `缺 Spring 依赖不误判（问题 ${pDeps.length} 条）`);

    console.log("=== ② 文件名保真 ===");
    const pName = await checkFile("backend/src/main/java/com/demo/AccountService.java", NAME_MISMATCH, KNOWN);
    ok(pName.length > 0, `★ public class 与文件名不符 → 必拒（捕获 ${pName.length} 条）`);

    console.log("=== ③ 批量归因 ===");
    const batch = await checkBatch([
        { path: "backend/src/main/java/com/demo/Good.java", content: GOOD.replace("AccountService", "Good") },
        { path: "backend/src/main/java/com/demo/Bad.java", content: BAD_SYNTAX.replace("AccountService", "Bad") },
        { path: "backend/src/main/java/com/demo/Other.java", content: CN_COMMENT.replace("AccountService", "Other") },
    ], KNOWN);
    const badKey = "backend/src/main/java/com/demo/Bad.java";
    const goodKey = "backend/src/main/java/com/demo/Good.java";
    const cnKey = "backend/src/main/java/com/demo/Other.java";
    ok(batch.has(badKey), "批量：坏文件被标红");
    ok(!batch.has(goodKey), "批量：好文件不被牵连");
    ok(!batch.has(cnKey), "批量：中文注释文件不被牵连");
    const badMsgs = batch.get(badKey) ?? [];
    ok(badMsgs.every(m => m.startsWith("Bad.java:")), `★ 诊断正确归因到 Bad.java（${badMsgs.slice(0, 2).join(" | ")}）`);
    ok(!badMsgs.some(m => m.includes("Good.java") || m.includes("Other.java")), "★ 诊断不串台到同批其他文件");

    console.log("=== ④ 不误伤其他类型 ===");
    ok((await checkFile("frontend/src/styles/theme.css", "a { color: #fff }", KNOWN)).length === 0, "css 不受影响");
    ok((await checkFile("pom.xml", "<project></project>", KNOWN)).length === 0, "xml 目前不拦（M3 由 mvnw 真验证，见计划备注）");

    console.log(`\n[java-gate-smoke] 通过 ${pass}，失败 ${fail}`);
    if (fail > 0) process.exit(1);
}

void main();
