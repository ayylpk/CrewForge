import { ChatDeepSeek } from "@langchain/deepseek"
import { parseTools,toDeclarations } from "./tools"

const MAPS: Record<string,any> = {"deepseek": initDeepSeek};
enum MODE{thinking,no_thinking};

function parseMode(thinking: boolean): MODE {
    if(thinking){
        return MODE.thinking;
    }

    return MODE.no_thinking;
}

function parseModel(provider: string):any{
    const initFn = MAPS[provider];

    return initFn;
}

function initDeepSeek(mode: MODE,data: any):ChatDeepSeek{

    const tools = parseTools(data.tools);

    if(mode == MODE.thinking){
        return new ChatDeepSeek({
            model: data.model,
            thinking: {type: "enabled"},
            reasoning_effort: data.reasoning_effort,
        } as any);
    }

    const res = new ChatDeepSeek({
        model: data.model,
        temperature: data.temperature,
        maxTokens: data.maxTokens,
        timeout: data.timeout,
        topP: data.top_p,
        tools: toDeclarations(tools),
        thinking: {type: "disabled"},
    } as any)

    return res;
}

export function initModels(Json: string){
    
    const data = JSON.parse(Json);
    const mode = parseMode(data.thinking);
    const init = parseModel(data.provider);

    return init(mode,data);
}