// ============================================================
// hubAdapter.ts —— 与现有 Hub 的收发适配
//
//   不改 Hub.ts / BaseAgent.ts，只用它们的公开能力（TransferStation）：
//     · register(name, role)          注册
//     · sendMessage(sender, receiver, content)  投递（空闲唤醒 / 忙则排队）
//     · waitForMessage(receiver)      阻塞取一条（收件箱是唯一事实来源）
//     · markDone(receiver)            处理完记账
//
//   本文件额外做三件事：出站统一序列化、入站运行时校验、**重复投递幂等**。
// ============================================================

import { TransferStation, roles } from "../Hub";
import type { Message, Role } from "../Hub";
import { parseInbound } from "./protocol";
import type { InboundMessage, OutboundMessage } from "./protocol";
import { hashOf, type DeveloperLedger } from "./ledger";

/** 本模块在 Hub 上的注册名 */
export const DEVELOPER_NAME = "developer";

/**
 * 角色值：旧 Hub 的 roles 枚举里没有 developer 项。
 * 为了**不改动旧代码**（加枚举项会改 Role 联合类型，可能打到别处的穷尽检查），
 * 这里用 unknown 兜底注册——按名字路由不受影响。
 * 若将来需要按角色路由，再单独提出扩展 Hub.roles（需单独告知）。
 */
export const DEVELOPER_ROLE: Role = roles.unknown;

export interface HubAdapterOptions {
    station: TransferStation;
    name?: string;
    role?: Role;
    /** 注入账本后，幂等键会落库（跨进程也有效） */
    ledger?: DeveloperLedger;
    /**
     * 受信的独立 TestAgent 名字（来自**代码配置**，不来自消息内容）。
     * 只有名单里的发送者发来的 test_passed / test_failure 才会被接受；
     * 不在名单里的一律拒绝并留痕——这是「任何发送者都能伪造通过」的第一道闸。
     * 默认空数组 = 谁也不信（安全默认）。
     */
    trustedTestAgents?: readonly string[];
}

export type ReceiveResult =
    | { status: "message"; message: InboundMessage; sender: string }
    | { status: "duplicate"; message: InboundMessage; sender: string }
    | { status: "invalid"; error: string; sender: string | null };

export class HubAdapter {
    readonly name: string;
    readonly role: Role;
    private readonly station: TransferStation;
    private readonly ledger: DeveloperLedger | undefined;
    /** 受信 TestAgent 名单：来自代码配置，不来自消息 */
    private readonly trustedTestAgents: readonly string[];
    private readonly memorySeen = new Set<string>();

    constructor(opts: HubAdapterOptions) {
        this.station = opts.station;
        this.name = opts.name ?? DEVELOPER_NAME;
        this.role = opts.role ?? DEVELOPER_ROLE;
        this.ledger = opts.ledger;
        this.trustedTestAgents = opts.trustedTestAgents ?? [];
        // Hub.register 会 new Hub 并清空 inbox——重复注册会丢掉在途消息，所以先探测
        if (!this.station.status[this.name]) {
            this.station.register(this.name, this.role);
        }
    }

    /** 发消息（自动 JSON 序列化 + 以自己为 sender） */
    send(target: string, message: OutboundMessage): "wake" | "queued" {
        const state = this.station.sendMessage(this.name, target, JSON.stringify(message));
        this.ledger?.appendEvent("outbound", { to: target, type: message.type, state });
        return state;
    }

    /**
     * 收一条：校验不过 → invalid，重复 → duplicate（都不抛给上层）。
     * 顺序固定为：结构校验 → **发送方信任校验** → 幂等 → 放行。
     * 信任校验必须排在幂等**之前**——伪造消息要每次都留痕，
     * 不能被"重复投递"当噪音静默吞掉。
     */
    async receive(): Promise<ReceiveResult> {
        let msg: Message | null = null;
        try {
            msg = await this.station.waitForMessage(this.name);
            if (!msg) return { status: "invalid", error: "收到空消息", sender: null };

            const parsed = parseInbound(msg.content);
            if (!parsed.ok) {
                this.ledger?.appendEvent("inbound_rejected", { from: msg.sender, error: parsed.error });
                return { status: "invalid", error: parsed.error, sender: msg.sender };
            }

            // ① 发送方信任校验：test_* 只接受代码配置里的 TestAgent
            const type = parsed.message.type;
            if (type === "test_passed" || type === "test_failure") {
                if (!this.trustedTestAgents.includes(msg.sender)) {
                    const error = `发送方「${msg.sender}」不在受信 TestAgent 名单，拒绝 ${type}`;
                    this.ledger?.appendEvent("inbound_untrusted", { from: msg.sender, type, error });
                    return { status: "invalid", error, sender: msg.sender };
                }
            }

            // ② 幂等键：同一条消息重复投递 → 跳过（不重复烧修复）
            const key = hashOf({ sender: msg.sender, content: msg.content });
            const firstTime = this.ledger ? this.ledger.markSeen(key) : this.markSeenInMemory(key);
            if (!firstTime) {
                this.ledger?.appendEvent("inbound_duplicate", { from: msg.sender, type });
                return { status: "duplicate", message: parsed.message, sender: msg.sender };
            }

            this.ledger?.appendEvent("inbound", { from: msg.sender, type });
            return { status: "message", message: parsed.message, sender: msg.sender };
        } finally {
            if (msg) this.station.markDone(this.name);
        }
    }

    /** 当前是否有待处理消息（供图在"等待外部测试结果"时判断） */
    hasPending(): boolean {
        return this.station.hasPending(this.name);
    }

    private markSeenInMemory(key: string): boolean {
        if (this.memorySeen.has(key)) return false;
        this.memorySeen.add(key);
        return true;
    }
}
