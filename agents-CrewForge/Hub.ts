// Hub.ts — 原型：F:\code\agent\rag\app\Hub.py（TransferStation + Hub，纯中转不决策）
// 需要的包：

import { z } from "zod";                        // 工具入参 schema（等价 Hub.py 的 input_schema 字典）
import { tool } from "@langchain/core/tools";   // 包装 send_message / wait_for_message 为 LangChain 工具

// agent 角色枚举（数字索引：manager=0 … maintainer=5，unknown=6 兜底）
// 注：带引号的成员名 + 数字值，访问用 roles.manager / roles["backendEngineer"]
export enum roles {"manager","architect","backendEngineer","frontendEngineer","testEngineer","maintainer","unknown"};

// 消息：等价 Hub.py 里塞进 inbox 的 dict（sender/receiver/content 三段）
export interface Message {
    sender: string;
    receiver: string;
    content: string;
}


export class Hub {
    // 每个 agent 一个 Hub：收件箱 + 唤醒事件
    role: number;
    inbox: Message[] = [];
    boss = "Hina";   // 负责人（原型里的字段，按需改）

    constructor(role:number,inbox: Message[]){
        this.role = role;
        this.inbox = inbox;
    };

    private _signaled = false;
    private _resolve: (() => void) | null = null;

    // 等消息（等价 event.wait()）：阻塞直到被唤醒；信号还在则立即通过
    wait(): Promise<void> {
        if (this._signaled) return Promise.resolve();
        return new Promise(res => { this._resolve = res; });
    }

    // 置信号（等价 event.set()）：唤醒正在等的人，信号保留给之后 wait() 的
    set(): void {
        this._signaled = true;
        this._resolve?.();
        this._resolve = null;
    }

    // 清信号（等价 event.clear()）：下次 wait 要重新等
    clear(): void {
        this._signaled = false;
        this._resolve = null;
    }
}

// agent 处理状态（等价 Hub.py 的 status 默认字典）
interface AgentStatus {
    role: number;
    isProcessing: boolean;        // 是否正在处理消息（忙/闲开关）
    pendingCount: number;         // 待处理消息数（队列里还有几条）
    totalProcessed: number;       // 累计处理条数（历史统计）
    lastProcessed: Message | null; // 最后处理的那条（审计用）
}

export class TransferStation{
    /// 消息中转站: 路由 + 状态管理
    teams: Record<string,Hub>;
    status: Record<string,AgentStatus>;

    constructor(teams: Record<string,Hub>, status: Record<string,AgentStatus>){
        this.teams = teams;
        this.status = status;
    }

    // 取 agent 的 Hub；不存在则自动创建（等价 defaultdict(Hub)——未注册的 receiver 也收得到消息）
    private getHub(name: string): Hub {
        return this.teams[name] ??= new Hub(6,[]);
    }

    // 取 agent 状态；不存在则创建默认值（等价 defaultdict 的自动创建，类似 Map.computeIfAbsent）
    private getStatus(name: string): AgentStatus {
        let s = this.status[name];
        if (!s) {
            s = { role: 6, isProcessing: false, pendingCount: 0, totalProcessed: 0, lastProcessed: null };
            this.status[name] = s;
        }
        return s;
    }


    // 唤醒等待中的 agent（等价 _wake_agent）
    private _wakeAgent(receiver: string): void {
        this.getHub(receiver).set();
    }

    // agent 进入等待，清除唤醒信号（等价 _put_agent_to_sleep）
    private _putAgentToSleep(receiver: string): void {
        this.getHub(receiver).clear();
    }

    // ── 对外接口 ──

    // 注册 agent：指定名字 + 角色（不注册的默认 unknown；重复注册覆盖）
    // 多开发场景：backend1/backend2 都注册成 roles.backendEngineer，按角色成组
    register(name: string, role: roles): void {
        this.teams[name] = new Hub(role, []);
        this.status[name] = { role, isProcessing: false, pendingCount: 0, totalProcessed: 0, lastProcessed: null };
    }

    // 按角色找"当前负载最低"的 agent（pendingCount 最小，待处理队列最短）；
    // 该角色没人注册返回 null。依赖各 agent 处理完消息调 markDone，否则计数只增不减
    pickLeastBusy(role: roles): string | null {
        let best: string | null = null;
        let bestLoad = Infinity;
        for (const [name, s] of Object.entries(this.status)) {
            if (s.role !== role) continue;
            if (s.pendingCount < bestLoad) { bestLoad = s.pendingCount; best = name; }
        }
        return best;
    }

    // 塞消息到接收者收件箱；空闲则唤醒干活。返回 "wake"（叫醒的）或 "queued"（它忙，排队）
    sendMessage(sender: string, receiver: string, content: string): "wake" | "queued" {
        const hub = this.getHub(receiver);
        const status = this.getStatus(receiver);

        hub.inbox.push({ sender, receiver, content });
        status.pendingCount += 1;

        if (!status.isProcessing) {
            // agent 空闲 → 唤醒干活
            status.isProcessing = true;
            this._wakeAgent(receiver);
            return "wake";
        }
        return "queued";
    }

    // 阻塞直到有消息，返回收件箱第一条（等价 wait_for_message）
    async waitForMessage(receiver: string): Promise<Message | null> {
        const hub = this.getHub(receiver);
        await hub.wait();

        return hub.inbox.shift() ?? null;
    }

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
