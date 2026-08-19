// ============================================================
// BaseAgent.ts —— Agent 类模板基类（消息驱动生命周期）
//
// 把 7 个 agent 文件里重复的"入口函数 + while(true) 消息循环 +
// JSON 解析 + if/else 分发 + markDone 记账"收敛成一个类：
//   子类构造时用 .on() 注册消息处理器（= 消息协议的一行），
//   启动时 new Xxx(station).start() 即可，循环和记账自动处理。
//
// 典型用法：
//   class Backend extends BaseAgent {
//     constructor(name, station) {
//       super(name, roles.backendEngineer, station);          // 构造即自动注册
//       this.on("task", ctx => this.enqueue(ctx.data.task),   // 按 type 匹配
//               { fromNames: ["architect", "merger"] });      // 按发送方过滤
//       this.on("revision", ctx => ..., { fromRoles: [roles.testEngineer] });  // 按角色过滤
//     }
//   }
// ============================================================

import { TransferStation, roles, type Message, type Role } from "./Hub";

/** 消息上下文：处理器拿到的全部信息 */
export interface MessageContext {
    msg: Message;
    data: Record<string, any>;   // 已解析的 JSON
    senderRole: Role;
    name: string;
    station: TransferStation;
}

type Handler = (ctx: MessageContext) => Promise<void> | void;

interface HandlerEntry {
    types: string[];
    fromNames: string[];
    fromRoles: Role[];
    run: Handler;
}

export class BaseAgent {
    protected readonly name: string;
    protected readonly role: Role;
    protected readonly station: TransferStation;
    private readonly handlers: HandlerEntry[] = [];

    constructor(name: string, role: Role, station: TransferStation) {
        this.name = name;
        this.role = role;
        this.station = station;
        this.station.register(name, role);   // 构造即注册（new 出来就能被寻址/负载均衡）
    }

    // ---------- 消息协议注册（子类构造时调用） ----------

    /** 两种调用都支持：on(type, handler) 或 on(type, opts, handler) */
    on(types: string | string[], opts: { fromNames?: string[]; fromRoles?: Role[] } | Handler, run?: Handler): this {
        let realOpts: { fromNames?: string[]; fromRoles?: Role[] } = {};
        let realRun: Handler;
        if (typeof opts === "function") {
            realRun = opts;                          // on(type, handler)
        } else {
            realOpts = opts ?? {};
            realRun = run!;                          // on(type, opts, handler)
        }
        this.handlers.push({
            types: Array.isArray(types) ? types : [types],
            fromNames: realOpts.fromNames ?? [],
            fromRoles: realOpts.fromRoles ?? [],
            run: realRun,
        });
        return this;
    }

    /** 发消息（自动 JSON 序列化 + 以自己为 sender） */
    protected send(receiver: string, payload: Record<string, any>): void {
        this.station.sendMessage(this.name, receiver, JSON.stringify(payload));
    }

    // ---------- 生命周期：启动钩子 → 消息循环 ----------

    async start(): Promise<void> {
        await this.onStart();
        await this.messageLoop();
    }

    /** 子类可覆盖：起 worker、初始化队列等 */
    protected async onStart(): Promise<void> {}

    /** 消息循环（protected 供 Manager 这种双循环 agent 组合使用） */
    protected async messageLoop(): Promise<void> {
        console.log(`[${this.name}] 消息监听已启动`);
        while (true) {
            const msg = await this.station.waitForMessage(this.name);
            if (!msg) { this.station.markDone(this.name); continue; }
            const data = this.parse(msg.content);
            const senderRole = this.station.status[msg.sender]?.role ?? roles.unknown;
            if (data !== null) {
                const handled = await this.dispatch({ msg, data, senderRole, name: this.name, station: this.station });
                if (!handled) this.onUnhandled(msg, data, senderRole);
            }
            this.station.markDone(this.name);   // 处理完记账（负载均衡数据基础）
        }
    }

    private parse(content: string): Record<string, any> | null {
        try { return JSON.parse(content) as Record<string, any>; } catch { return null; }
    }

    private async dispatch(ctx: MessageContext): Promise<boolean> {
        for (const h of this.handlers) {
            if (h.types.length && !h.types.includes(ctx.data.type)) continue;
            if (h.fromNames.length && !h.fromNames.includes(ctx.msg.sender)) continue;
            if (h.fromRoles.length && !h.fromRoles.includes(ctx.senderRole)) continue;
            await h.run(ctx);
            return true;
        }
        return false;
    }

    protected onUnhandled(msg: Message, data: Record<string, any>, senderRole: Role): void {
        console.log(`[${this.name}] 未匹配消息：${msg.sender} → ${data?.type ?? "?"}`);
    }
}
