// ============================================================
// Hub.ts —— 消息中转基础设施（精简移植自 _legacy-agents/Hub.ts）
// 内容：角色枚举 + 消息 + 中转站（路由/状态/负载均衡）+ 工位队列 + 信号量
// 不依赖任何外部包（纯 JS 逻辑），classes 项目自洽
// ============================================================

// agent 角色定义（数字值：manager=0 … maintainer=5，unknown=6 兜底）
export const roles = {
    manager: 0,
    architect: 1,
    backendEngineer: 2,
    frontendEngineer: 3,
    testEngineer: 4,
    maintainer: 5,
    unknown: 6,
    merger: 7
} as const;
export type Role = (typeof roles)[keyof typeof roles];

// 消息：sender / receiver / content 三段
export interface Message {
    sender: string;
    receiver: string;
    content: string;
}

// 每 agent 一个 Hub：收件箱 + 唤醒事件
export class Hub {
    role: number;
    inbox: Message[] = [];
    boss = "Hina";

    constructor(role: number, inbox: Message[]) {
        this.role = role;
        this.inbox = inbox;
    }

    private _signaled = false;
    private _resolve: (() => void) | null = null;

    wait(): Promise<void> {
        if (this._signaled) return Promise.resolve();
        return new Promise(res => { this._resolve = res; });
    }

    set(): void {
        this._signaled = true;
        this._resolve?.();
        this._resolve = null;
    }

    clear(): void {
        this._signaled = false;
        this._resolve = null;
    }
}

// agent 处理状态（负载均衡数据基础）
interface AgentStatus {
    role: Role;   // 字面量联合类型（0-6）而非 number：BaseAgent 的 senderRole: Role 才能赋值
    isProcessing: boolean;
    pendingCount: number;
    totalProcessed: number;
    lastProcessed: Message | null;
}

export class TransferStation {
    teams: Record<string, Hub>;
    status: Record<string, AgentStatus>;

    constructor(teams: Record<string, Hub>, status: Record<string, AgentStatus>) {
        this.teams = teams;
        this.status = status;
    }

    private getHub(name: string): Hub {
        return this.teams[name] ??= new Hub(6, []);
    }

    private getStatus(name: string): AgentStatus {
        let s = this.status[name];
        if (!s) {
            s = { role: roles.unknown, isProcessing: false, pendingCount: 0, totalProcessed: 0, lastProcessed: null };
            this.status[name] = s;
        }
        return s;
    }

    private _wakeAgent(receiver: string): void {
        this.getHub(receiver).set();
    }

    private _putAgentToSleep(receiver: string): void {
        this.getHub(receiver).clear();
    }

    /** 注册 agent：指定名字 + 角色（重复注册覆盖） */
    register(name: string, role: Role): void {
        this.teams[name] = new Hub(role, []);
        this.status[name] = { role, isProcessing: false, pendingCount: 0, totalProcessed: 0, lastProcessed: null };
    }

    /** 按角色找"当前负载最低"的 agent（多实例负载均衡；没人注册返回 null） */
    pickLeastBusy(role: Role): string | null {
        let best: string | null = null;
        let bestLoad = Infinity;
        for (const [name, s] of Object.entries(this.status)) {
            if (s.role !== role) continue;
            if (s.pendingCount < bestLoad) { bestLoad = s.pendingCount; best = name; }
        }
        return best;
    }

    /** 塞消息：空闲唤醒干活，忙则排队。返回 "wake" 或 "queued" */
    sendMessage(sender: string, receiver: string, content: string): "wake" | "queued" {
        const hub = this.getHub(receiver);
        const status = this.getStatus(receiver);
        hub.inbox.push({ sender, receiver, content });
        status.pendingCount += 1;
        if (!status.isProcessing) {
            status.isProcessing = true;
            this._wakeAgent(receiver);
            return "wake";
        }
        return "queued";
    }

    /** 阻塞直到有消息，返回收件箱第一条（收件箱是唯一事实来源，wait 只负责唤醒） */
    async waitForMessage(receiver: string): Promise<Message | null> {
        const hub = this.getHub(receiver);
        while (hub.inbox.length === 0) {
            hub.clear();
            await hub.wait();
        }
        return hub.inbox.shift() ?? null;
    }

    /** 处理完记账：pendingCount -1，归零则休眠（负载均衡数据基础） */
    markDone(receiver: string): void {
        const status = this.getStatus(receiver);
        status.pendingCount -= 1;
        status.totalProcessed += 1;
        if (status.pendingCount === 0) {
            status.isProcessing = false;
            this._putAgentToSleep(receiver);
        }
    }

    hasPending(receiver: string): boolean {
        return this.getStatus(receiver).pendingCount > 0;
    }
}

// 信号量工作队列：push 入队唤醒，pop 阻塞等待（开发工位流水线用）
export class WorkQueue<T> {
    private items: T[] = [];
    private _resolve: (() => void) | null = null;

    push(item: T): void {
        this.items.push(item);
        this._resolve?.();
        this._resolve = null;
    }

    async pop(): Promise<T> {
        while (this.items.length === 0) {
            await new Promise<void>(res => { this._resolve = res; });
        }
        return this.items.shift()!;
    }
}

// 信号量：并发上限控制（limit=1 即互斥锁）
export class Semaphore {
    private available: number;
    private waiters: (() => void)[] = [];

    constructor(limit: number) { this.available = limit; }

    async acquire(): Promise<void> {
        if (this.available > 0) { this.available--; return; }
        await new Promise<void>(res => this.waiters.push(res));
    }

    release(): void {
        const next = this.waiters.shift();
        if (next) next();
        else this.available++;
    }
}
