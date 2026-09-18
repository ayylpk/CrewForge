// tests/developer-line-drain.test.ts —— 残消息清理**必须收敛**（9/18 同步死循环事故的回归）
//
//   事故现场（实测，不是假想）：
//     `drainStale` 原实现是
//       `while (station.hasPending(NAME)) { void station.waitForMessage(NAME)?.then((d) => { markDone(...) }) }`
//     —— `hasPending` 读的是记账计数 `pendingCount`，而**唯一能让它减一的 `markDone` 写在 `.then` 里**。
//     微任务在那个**同步** while 里永远排不上队，所以只要收件箱有积压就是**同步空转**：
//     一个核烧穿（实测 8 秒烧 9.44 秒 CPU）、一行日志不出、事件循环堵死、`process.exit` 到不了。
//     代价：harness 的"等子进程退出"挂了 2961 秒，那份 pass 判定最后靠人手动 kill 才拿到。
//
//   ⚠️ 本文件因此有一条特殊性质：**旧实现下这些用例根本回不来**（同步死循环无法被超时打断）。
//      也就是说它们不是"跑得慢"，而是"跑不动"——这条回归本身就是修复的证明。
import { describe, expect, it } from "bun:test";
import { TransferStation, roles } from "../Hub";
import { DEVELOPER_NAME } from "../developerAgent/hubAdapter";
import { drainStale } from "../developerTeamRunner";

function freshStation(): TransferStation {
    const station = new TransferStation({}, {});
    station.register(DEVELOPER_NAME, roles.unknown);
    return station;
}

function queue(station: TransferStation, n: number, type = "developer_progress"): void {
    for (let i = 0; i < n; i++) {
        station.sendMessage("architect", DEVELOPER_NAME, JSON.stringify({ type, i }));
    }
}

describe("hasQueued：读**真实队列**，与记账计数解耦", () => {
    it("没注册过的名字 = 没有队列 = false（且不惰性建箱）", () => {
        const station = freshStation();
        expect(station.hasQueued("nobody")).toBe(false);
        expect(station.teams["nobody"]).toBeUndefined();     // 没被顺手创建
    });

    it("有消息 → true；消费掉 → false", async () => {
        const station = freshStation();
        queue(station, 1);
        expect(station.hasQueued(DEVELOPER_NAME)).toBe(true);
        const m = await station.waitForMessage(DEVELOPER_NAME);
        expect(m).not.toBeNull();
        expect(station.hasQueued(DEVELOPER_NAME)).toBe(false);
    });

    it("★ hasQueued 为真时 waitForMessage 一定拿得到消息（不会挂住）", async () => {
        const station = freshStation();
        queue(station, 2);
        for (let i = 0; i < 2; i++) {
            expect(station.hasQueued(DEVELOPER_NAME)).toBe(true);
            expect(await station.waitForMessage(DEVELOPER_NAME)).not.toBeNull();
        }
        expect(station.hasQueued(DEVELOPER_NAME)).toBe(false);
    });
});

describe("drainStale：清完就返回（旧实现是同步死循环）", () => {
    it("★ 队列里 3 条 → 全部清掉并返回，不挂住", async () => {
        const station = freshStation();
        queue(station, 3);
        await drainStale(station);
        expect(station.hasQueued(DEVELOPER_NAME)).toBe(false);
        expect(station.status[DEVELOPER_NAME]!.pendingCount).toBe(0);
    });

    it("空队列 → 立刻返回（不空转）", async () => {
        const station = freshStation();
        await drainStale(station);
        expect(station.hasQueued(DEVELOPER_NAME)).toBe(false);
    });

    it("★ 重复调用幂等：清过一次再清一次也是立刻返回", async () => {
        const station = freshStation();
        queue(station, 5);
        await drainStale(station);
        await drainStale(station);
        expect(station.hasQueued(DEVELOPER_NAME)).toBe(false);
        expect(station.status[DEVELOPER_NAME]!.pendingCount).toBe(0);
    });

    it("大积压（600 条，超过上界 500）也能返回——上界是「报警退出」而不是「烧死」", async () => {
        const station = freshStation();
        queue(station, 600);
        await drainStale(station);          // 不挂住即通过；上界触发时只 warn
        expect(station.hasQueued(DEVELOPER_NAME)).toBe(true);   // 上界后主动停手，剩余留在队列里（如实如此）
    });
});
