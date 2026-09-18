import { ChatOpenAI } from "@langchain/openai"
import { Tools } from "./tool";

export const agent = new ChatOpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEFAULT_MODEL,
    configuration: {baseURL: process.env.DEEPSEEK_BASE_URL},
}).bindTools(Tools);

// 9/4 伤⑤：indexesAgent 孤儿导出（唯一用户 indexes.ts 已随死代码归档），一并清除