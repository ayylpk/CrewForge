const { Manager } = await import("./manager.ts");
const { CliQuestioner } = await import("./GraphFactory.ts");
const { HumanMessage } = await import("@langchain/core/messages");

console.log("KEY loaded:", process.env.DEEPSEEK_API_KEY ? process.env.DEEPSEEK_API_KEY.slice(0, 10) + "..." : "NO");

const m = new Manager();
const s = await m.run(
    { messages: [new HumanMessage("做一个多用户心理陪伴 Web 应用，需要用户注册登录、独立会话空间、聊天接口、WebSocket 主动推送")] },
    "debug-t1",
    new CliQuestioner(),
);
console.log("STATE KEYS:", Object.keys(s));
console.log("plan?", JSON.stringify(s?.plan)?.slice(0, 300));
console.log("functions?", JSON.stringify(s?.functions)?.slice(0, 200));
