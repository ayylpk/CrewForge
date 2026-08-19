
interface Tool{
    name: string;
    description: string;
    code: string;
    parameters?: object; 
}

export function parseTools(tools: string | Tool[] | null | undefined): Tool[] {
  if (!tools) return [];
  if (Array.isArray(tools)) return tools;
  try {
    const parsed = JSON.parse(tools);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[initDeepSeek] tools JSON 解析失败:", err);
    return [];
  }
}

export function toDeclarations(tools: Tool[]) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? {},
    },
  }));
}

export function createToolFn(code: string): (args: any) => Promise<any> {
  try {
    const fn = new Function(`return (${code})`)();
    if (typeof fn === "function") return fn;
  } catch (err) {
    console.error("[initDeepSeek] 工具代码不是合法函数:", err);
  }
  throw new Error(`工具代码无法执行: ${code.slice(0, 50)}...`);
}