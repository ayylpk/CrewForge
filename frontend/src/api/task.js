import request from './request';
/** 从任务桥已有字段计算质量摘要；不引入会话级状态，也不依赖 LLM。 */
export function summarizeTaskQuality(tasks) {
    const terminal = tasks.filter((task) => task.status === 'done' || task.status === 'failed');
    const categoryCounts = new Map();
    for (const task of terminal.filter((item) => item.status === 'failed')) {
        const text = task.errorMsg || '';
        const label = /import|导出|export|request\.ts|utils[\\/]request/i.test(text) ? 'Import/导出' :
            /api|接口|路由|mapping|endpoint|method|path/i.test(text) ? 'API 契约' :
                /编译|syntax|type.?check|compile|语法/i.test(text) ? '编译/语法' :
                    /白屏|渲染|render|dom|页面/i.test(text) ? '渲染/UI' :
                        /依赖|dependency|package|npm|bun|maven|gradle/i.test(text) ? '依赖' :
                            /落盘|数据库|持久化|database|persist|upsert/i.test(text) ? '持久化' : '其他';
        categoryCounts.set(label, (categoryCounts.get(label) || 0) + 1);
    }
    const evaluated = terminal.length;
    const passed = terminal.filter((task) => task.status === 'done').length;
    return {
        evaluated,
        passed,
        failed: evaluated - passed,
        firstPassRate: evaluated ? Math.round((terminal.filter((task) => task.status === 'done' && task.retryCount === 0).length / evaluated) * 100) : 0,
        totalRetries: tasks.reduce((sum, task) => sum + Math.max(0, task.retryCount || 0), 0),
        failureCategories: [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
    };
}
/** 查询项目的全部任务（看板用） */
export function fetchTasks(projectId) {
    return request.get('/api/task/list', { params: { projectId } });
}
/** 按状态过滤 */
export function fetchTasksByStatus(projectId, status) {
    return request.get('/api/task/list', { params: { projectId, status } });
}
/** 查询单个任务 */
export function fetchTaskById(id) {
    return request.get(`/api/task/${id}`);
}
/** 更新任务状态（看板拖拽 / 引擎推进） */
export function updateTaskStatus(id, status, errorMsg) {
    return request.put(`/api/task/${id}/status`, { status, errorMsg });
}
/** 重跑任务 */
export function retryTask(id) {
    return request.post(`/api/task/${id}/retry`);
}
/** 创建任务 */
export function createTask(data) {
    return request.post('/api/task', data);
}
