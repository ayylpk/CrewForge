import mysql, { type RowDataPacket } from "mysql2/promise";

const pool = mysql.createPool({
    host: "localhost",
    user: "root",
    password: "qwer1016LPK",
    database: "crewforge",
})

interface Node extends RowDataPacket{
    nodeName: string,
    description: string,
    systemPrompt: string,
    temperature: number,
    tools: string[],
    model: string,
}

interface agent{
    name: string,
    role: string,
    nodes: Node[]
}

async function getNodes(agentId: number): Promise<Node[]> {
    const [nodes] = await pool.query<Node[]>(
        "select * from sys_agent_node where agent_id = ?",
        [agentId]
    );

    const Nodes: Node[] = [];
    for(const node of nodes){
        const temp = {} as Node;
        if(node !== null){
            temp.nodeName = node.node_name;
            temp.description = node.description;
            temp.systemPrompt = node.description;
            temp.temperature = node.temperature;
            temp.model = node.model;
        }
        Nodes.push(temp)
    } 

    return Nodes;
}

