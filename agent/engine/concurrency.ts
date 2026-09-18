// ============================================================
// concurrency.ts —— T7a 令牌闸（9/8 用户拍板模型：队列无上限，token 限并发）
//
//   典型生产者-消费者：push 随便堆（WorkQueue 不动），消费侧先 acquire 再干活，
//   **真的落盘（或判失败）之后才 release**——调用方全部 try/finally 包住。
//   闸的分布：
//     gate("llm")            最外层端点总闸（F1 教训：8 并发尾延迟 116~443s）
//     gate("backend.pseudo") 后端 A 工位（伪代码在制 ≤ stationSlots）
//     gate("backend.code")   后端 B 工位（整任务生成+写盘算一件在制）
//     gate("frontend.design")/gate("frontend.code") 前端两阶段同理
//   动态限额：每次 acquire 现读 sys_settings（station_slots/llm_concurrency，30s 缓存），
//   设置页改大立即多放行、改小不踢正在跑的（只影响新来的排队）——热调不重启。
//   不用 Hub.ts 里的旧 Semaphore（那个限额定死且全仓零消费），这把支持动态缩扩 + 观测。
// ============================================================

import { runtimeSettings } from "./settings";

/** 限额来源：具名闸各读各的配置位；settings 没到位用出厂默认（旁路=永不因配置层挂死流水线） */
function limitOf(name: string): number {
    const rt = runtimeSettings();
    const raw = name === "llm" ? rt?.llmConcurrency ?? 6 : rt?.stationSlots ?? 5;
    return Math.max(1, Math.floor(raw));   // 手滑填 0/负数按 1 处理——闸不能焊死
}

/** 测试注入口：pin 住某把闸的限额（冒烟不吃 DB）；clear 后恢复读配置 */
const pinned = new Map<string, number>();
export function pinGateLimit(name: string, n: number | null): void {
    if (n == null) pinned.delete(name); else pinned.set(name, Math.max(1, Math.floor(n)));
}

export class TokenGate {
    private inUse = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(readonly name: string) {}

    private limit(): number {
        return pinned.get(this.name) ?? limitOf(this.name);
    }

    /** 拿令牌：有就秒过；满了挂队列等唤醒（唤醒后重查——极端情形被插队就继续等，不会丢唤醒）。
     *  等超过 10s 打一行观测日志 */
    async acquire(): Promise<void> {
        for (;;) {
            if (this.inUse < this.limit()) { this.inUse++; return; }
            const t0 = Date.now();
            await new Promise<void>(res => this.waiters.push(res));
            if (Date.now() - t0 > 10_000) console.log(`[gate:${this.name}] 排队 ${(Date.now() - t0) / 1000 | 0}s（在制 ${this.inUse}/${this.limit()}）`);
        }
    }

    /** 归还令牌：**调用方负责 try/finally**（落盘或失败才算归还——用户拍板的归还时机） */
    release(): void {
        this.inUse--;
        this.waiters.shift()?.();
    }

    /** 观测/冒烟断言用 */
    stats(): { name: string; inUse: number; limit: number; waiting: number } {
        return { name: this.name, inUse: this.inUse, limit: this.limit(), waiting: this.waiters.length };
    }
}

const gates = new Map<string, TokenGate>();
export function gate(name: string): TokenGate {
    let g = gates.get(name);
    if (!g) { g = new TokenGate(name); gates.set(name, g); }
    return g;
}
