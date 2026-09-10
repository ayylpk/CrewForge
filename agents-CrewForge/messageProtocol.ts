// messageProtocol.ts —— Hub 消息的确定性协议层
// Hub 只负责中转；本文件只做结构校验，不做路由或业务决策。
import { z } from "zod";

const taskShape = z.object({
  id: z.string().min(1),
  layer: z.enum(["backend", "frontend"]),
  method: z.string().min(1),
  path: z.string().min(1),
  files: z.array(z.string()),
  title: z.string().min(1),
  description: z.string(),
  parameters: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean(), description: z.string() })),
  acceptance: z.string(),
  phase: z.number().int().optional(),
  stack: z.unknown().optional(),
}).passthrough();

export const MessageEnvelopeSchema = z.object({
  sender: z.string().min(1),
  receiver: z.string().min(1),
  content: z.string(),
});
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

export const PhasePlanMessageSchema = z.object({
  type: z.literal("phase_plan"),
  projectId: z.number().int().positive(),
  phase: z.object({ phase: z.number().int(), name: z.string().min(1) }).passthrough(),
  plan: z.unknown(),
}).passthrough();

export const TaskMessageSchema = z.object({ type: z.literal("task"), task: taskShape }).passthrough();
export const TaskResultMessageSchema = z.object({
  type: z.literal("task_result"), task: taskShape, success: z.boolean(),
}).passthrough();
export const PairReadyMessageSchema = z.object({
  type: z.literal("pair_ready"), phase: z.number().int(),
  pair: z.object({ back: taskShape, front: taskShape.nullable() }).passthrough(),
}).passthrough();
export const PhaseDoneMessageSchema = z.object({
  type: z.literal("phase_done"), phase: z.number().int(), failed: z.array(z.unknown()),
}).passthrough();
export const PhaseRequestMessageSchema = z.object({
  type: z.literal("phase_request"), phase: z.number().int(),
}).passthrough();

const knownMessageSchemas = [
  PhasePlanMessageSchema, TaskMessageSchema, TaskResultMessageSchema,
  PairReadyMessageSchema, PhaseDoneMessageSchema, PhaseRequestMessageSchema,
] as const;

/** Parse a Hub payload once at the boundary. Invalid/unknown messages are rejected. */
export function parseMessagePayload(content: string): Record<string, unknown> | null {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  for (const schema of knownMessageSchemas) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data as Record<string, unknown>;
  }
  return null;
}

/** Known messages are strict; legacy/extension messages remain routable for compatibility. */
export function parseMessagePayloadCompatible(content: string): Record<string, unknown> | null {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  if (!value || typeof value !== "object" || typeof (value as any).type !== "string") return null;
  const type = (value as any).type as string;
  const schema = knownMessageSchemas.find((candidate) => {
    const literal = candidate.shape.type as z.ZodLiteral<string>;
    return literal.value === type;
  });
  if (!schema) return value as Record<string, unknown>;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data as Record<string, unknown> : null;
}

export function parseMessageEnvelope(sender: string, receiver: string, content: string): MessageEnvelope | null {
  const payload = parseMessagePayload(content);
  if (!payload) return null;
  const envelope = MessageEnvelopeSchema.safeParse({ sender, receiver, content });
  return envelope.success ? envelope.data : null;
}
