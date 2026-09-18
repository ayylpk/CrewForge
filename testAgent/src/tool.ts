import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { Dirent } from 'fs';
import path from 'path';
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

const execAsync = promisify(exec);

// ============================================================
// 共享：索引管理 + 临时 LLM
// ============================================================
const INDEX_FILE = 'indexes.md';

const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
  '.css', '.scss', '.less', '.html', '.json', '.md',
  '.py', '.java', '.go', '.rs', '.rb', '.php',
  '.yaml', '.yml', '.toml', '.xml', '.sql',
]);

function createTempLLM() {
  return new ChatOpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEFAULT_MODEL,
    configuration: { baseURL: process.env.DEEPSEEK_BASE_URL },
  });
}

/** 从 indexes.md 提取某文件的描述行 */
async function getIndexEntry(relPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(INDEX_FILE, 'utf-8');
    const lines = content.split('\n');
    let inTarget = false;
    const descs: string[] = [];
    for (const line of lines) {
      if (line.startsWith(`-- ${relPath}`)) { inTarget = true; continue; }
      if (inTarget) {
        if (line.startsWith('-- ')) break;
        const trimmed = line.trim();
        if (trimmed) descs.push(trimmed);
      }
    }
    return descs.length > 0 ? descs.join('\n') : null;
  } catch { return null; }
}

/** 从 indexes.md 提取所有文件路径 */
async function getIndexedFiles(): Promise<string[] | null> {
  try {
    const content = await fs.readFile(INDEX_FILE, 'utf-8');
    const files: string[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-- ')) {
        const file = trimmed.slice(3).trim();
        if (file) files.push(file);
      }
    }
    return files.length > 0 ? files : null;
  } catch { return null; }
}

/** 检查文件是否已有索引条目 */
async function isFileIndexed(relPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(INDEX_FILE, 'utf-8');
    return content.includes(`-- ${relPath}\n`);
  } catch { return false; }
}

/** 用 LLM 分析单个文件，生成索引条目 */
async function generateFileIndexEntry(relPath: string, content: string): Promise<string> {
  const ext = path.extname(relPath).toLowerCase();
  if (!TEXT_EXTS.has(ext)) return `-- ${relPath}\n`;

  const llm = createTempLLM();
  const res = await llm.invoke([
    new SystemMessage(
      '分析以下文件内容，提取其中有意义的"条目"（名称和用途），按文件类型区分：\n' +
      '- 代码文件：提取函数、类、组件、接口、类型定义\n' +
      '- 样式文件：提取 CSS 类名、ID、变量\n' +
      '- JSON 文件：提取顶层键名\n' +
      '- Markdown 文件：提取标题\n' +
      '按以下格式返回，每行一个，不要有多余内容：\n' +
      '名称 — 用途描述\n' +
      '如果无法确定用途，只写名称即可。'
    ),
    new HumanMessage(content.slice(0, 20000)), // 只喂前 2 万字建索引，巨型文件不炸临时 LLM 的 context
  ]);
  const text = typeof res.content === 'string' ? res.content
    : res.content.map(c => ('text' in c ? c.text : '')).join('\n');

  let entry = `-- ${relPath}\n`;
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('```')) continue;
    trimmed = trimmed.replace(/^[-*]\s+/, '');
    const sep = trimmed.indexOf(' — ');
    let name: string, des: string;
    if (sep > 0) {
      name = trimmed.slice(0, sep).trim();
      des = trimmed.slice(sep + 3).trim();
    } else if (/^[a-zA-Z_$][\w$]+$/.test(trimmed)) {
      name = trimmed; des = '';
    } else continue;
    if (seen.has(name)) continue;
    seen.add(name);
    entry += `   ${name}`;
    if (des) entry += ` — ${des}`;
    entry += '\n';
  }
  return entry;
}

/** 追加索引条目到 indexes.md */
async function appendToIndex(entry: string): Promise<void> {
  try { await fs.appendFile(INDEX_FILE, entry, 'utf-8'); }
  catch { await fs.writeFile(INDEX_FILE, `# 项目代码索引\n\n${entry}`, 'utf-8'); }
}

/** 更新已有文件的索引条目（edit 后调用） */
async function updateFileIndex(relPath: string, content: string): Promise<void> {
  const newEntry = await generateFileIndexEntry(relPath, content);
  try {
    const existing = await fs.readFile(INDEX_FILE, 'utf-8');
    const marker = `-- ${relPath}\n`;
    const start = existing.indexOf(marker);
    if (start === -1) { await appendToIndex(newEntry); return; }
    const afterStart = start + marker.length;
    const rest = existing.slice(afterStart);
    const nextMatch = rest.match(/\n-- /);
    const end = nextMatch ? afterStart + nextMatch.index! : existing.length;
    await fs.writeFile(INDEX_FILE, existing.slice(0, start) + newEntry + existing.slice(end), 'utf-8');
  } catch { await appendToIndex(newEntry); }
}

// ============================================================
// 工具 ①：bash
//
// 9/4 修复（伤①+⑥）：
//   - 超时 30s → BASH_TIMEOUT_MS（默认 600s）：mvn/npm install 级命令 30s 必死
//   - 非 0 退出旧版只回吐 err.stderr，而 Maven 测试报告几乎全在 stdout——
//     模型看不见错误详情就无从判断怎么修，现在 exit code + stdout + stderr 三件套全给
//   - 输出统一头尾截断（≤8000 字符），保 context 不被测试日志塞爆
//   - 超时/缓冲溢出单独标注，防止模型把"没跑完/没接住"误判成"测试失败"
// ============================================================
const BASH_TIMEOUT_MS = Number(process.env.BASH_TIMEOUT_MS || 600000);
const MAX_OUTPUT_CHARS = 8000;
// Node exec 在 Windows 默认走 cmd.exe，而提示词承诺的是 Git Bash——
// 单引号/$(...)/heredoc 在 cmd 下全崩。锁到 bash（PATH 里有 Git 的 bash.exe），可用 BASH_SHELL 覆盖。
const BASH_SHELL = process.env.BASH_SHELL || (process.platform === 'win32' ? 'bash' : undefined);

/** 超长输出保留头 4800 + 尾 3200（测试失败摘要通常在尾部），中间截断 */
function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = text.slice(0, 4800);
  const tail = text.slice(-3200);
  return `${head}\n\n... [中间 ${text.length - 8000} 字符已截断；要看完整日志请把命令输出重定向落盘（... > out.log 2>&1）后再 read] ...\n\n${tail}`;
}

export const bashTool = new DynamicStructuredTool({
  name: "bash",
  description: "执行 shell 命令（编译、测试、运行）。超时默认 10 分钟，可用环境变量 BASH_TIMEOUT_MS 调整。",
  schema: z.object({ command: z.string().describe("要执行的 shell 命令") }),
  func: async ({ command }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10MB：默认 1MB 会被大测试日志直接炸掉
        ...(BASH_SHELL ? { shell: BASH_SHELL } : {}),
      });
      let result = "exit code: 0\n";
      if (stdout) result += `stdout:\n${stdout}\n`;
      if (stderr) result += `stderr:\n${stderr}\n`;
      return truncateOutput(result);
    } catch (err: any) {
      // 三分法：跑不出来（溢出/超时/不存在）≠ 跑出来且失败（非 0 退出）
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return `[OUTPUT_OVERFLOW] 命令输出超过 10MB 缓冲，这 ≠ 测试失败。请重跑并把输出落盘：${command} > out.log 2>&1，再用 grep 定位错误行。`;
      }
      if (err.killed === true) {
        const partial = [err.stdout, err.stderr].filter(Boolean).join('\n');
        return truncateOutput(
          `[TIMEOUT] 命令超过 ${Math.round(BASH_TIMEOUT_MS / 1000)}s 被终止。这 ≠ 测试失败，只代表跑太久（可能在等交互输入或进程不退出）。` +
          `考虑：加 --ci / --no-watch 类参数、只跑部分测试、检查命令是否会挂起。\n` +
          (partial ? `已捕获的部分输出:\n${partial}` : `(未捕获到输出)`)
        );
      }
      if (err.code === 'ENOENT') {
        return `[COMMAND_NOT_FOUND] 命令不存在: ${command}\n请确认程序名与 PATH。`;
      }
      // 真正的非 0 退出：错误详情都在 err.stdout/err.stderr 上，必须全量返回——这是模型判断修法的第一手信息
      const code = typeof err.code === 'number' ? err.code : 'unknown';
      let result = `exit code: ${code}\n`;
      if (err.stdout) result += `stdout:\n${err.stdout}\n`;
      if (err.stderr) result += `stderr:\n${err.stderr}\n`;
      return truncateOutput(result || `执行失败: ${err.message}`);
    }
  },
});

// ============================================================
// 工具 ②：read — 读文件 + 自动建索引
// ============================================================
const MAX_LINES = 2000;
const SAFETY_LIMIT = 50 * 1024 * 1024;

export const readTool = new DynamicStructuredTool({
  name: "read",
  description: "读取文件内容，带行号显示，支持 offset/limit 分页续读。首次读取时自动生成索引。",
  schema: z.object({
    address: z.string().describe("文件路径（绝对或相对路径）"),
    offset: z.number().optional().describe("从第 N 行开始读（1 起，默认 1）；文件被截断时用返回值里的提示续读"),
    limit: z.number().optional().describe(`本次返回的行数，默认 ${MAX_LINES}`),
  }),
  func: async ({ address, offset, limit }) => {
    try {
      const st = await fs.stat(address);

      // 目录
      if (st.isDirectory()) {
        const indexed = await getIndexedFiles();
        if (indexed) {
          const prefix = address.replace(/\\/g, '/').replace(/\/$/, '');
          const matched = indexed.filter(f => f.startsWith(prefix + '/'));
          if (matched.length > 0) return `📁 ${address}/\n${matched.map(f => `  📄 ${f}`).join('\n')}`;
        }
        return `📁 ${address}/ 是一个目录，请使用 bash ls 查看目录内容。`;
      }

      if (st.size > SAFETY_LIMIT) return `⚠️ 文件过大 (${(st.size / 1024 / 1024).toFixed(1)}MB)。`;

      let content: string;
      try { content = await fs.readFile(address, 'utf-8'); }
      catch { return `⚠️ 无法以文本方式读取（可能是二进制文件）。路径: ${address}`; }

      const lines = content.split('\n');
      const total = lines.length;
      // ⑧ 分页：默认从头 MAX_LINES 行，向后兼容旧调用
      const start = Math.max(1, Math.floor(offset ?? 1));
      const count = Math.max(1, Math.floor(limit ?? MAX_LINES));
      const showLines = lines.slice(start - 1, start - 1 + count);
      const endLine = start - 1 + showLines.length;
      const remained = total - endLine;

      const relPath = address.replace(/\\/g, '/');
      let result = `📄 ${path.basename(address)}  (共 ${total} 行，显示第 ${start}-${endLine} 行)\n`;

      // 已有索引摘要
      const entry = await getIndexEntry(relPath);
      if (entry) {
        result += `📋 索引摘要:\n${entry}\n---\n`;
      } else {
        // 首次读 → 自动生成索引并追加
        const newEntry = await generateFileIndexEntry(relPath, content);
        await appendToIndex(newEntry);
        const desc = newEntry.split('\n').slice(1).filter(Boolean).join('\n');
        if (desc) result += `📋 索引摘要:\n${desc}\n---\n`;
      }

      // 行号必须是绝对行号（分页续读时 i 只是页内偏移）
      result += showLines.map((l, i) => `${start + i}\t${l}`).join('\n');
      if (remained > 0) result += `\n\n... 还有 ${remained} 行未显示，可用 offset=${endLine + 1} 续读`;
      return result;
    } catch (err: any) {
      if (err.code === 'ENOENT') return `❌ 文件不存在: ${address}`;
      if (err.code === 'EACCES') return `❌ 无权限读取: ${address}`;
      return `❌ 读取失败: ${err.message}`;
    }
  },
});

// ============================================================
// 工具 ③：grep — 搜索（优先用索引文件列表）
// ============================================================
async function grepInFiles(files: string[], regex: RegExp, maxResults: number): Promise<string[]> {
  const results: string[] = [];
  for (const file of files) {
    if (results.length >= maxResults) break;
    try {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break;
        const line = lines[i];
        if (!line) continue;
        if (regex.test(line)) results.push(`${file}:${i + 1}:${line.trim().substring(0, 200)}`);
      }
    } catch { /* 跳过 */ }
  }
  return results;
}

async function recursiveGrep(dir: string, regex: RegExp, basePath: string, maxResults: number): Promise<string[]> {
  const results: string[] = [];
  let entries: Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (results.length >= maxResults) break;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await recursiveGrep(full, regex, basePath, maxResults));
    } else if (entry.isFile()) {
      try {
        const content = await fs.readFile(full, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          const line = lines[i];
          if (!line) continue;
          if (regex.test(line)) {
            results.push(`${path.relative(basePath, full).replace(/\\/g, '/')}:${i + 1}:${line.trim().substring(0, 200)}`);
          }
        }
      } catch { /* 跳过 */ }
    }
  }
  return results;
}

export const grepTool = new DynamicStructuredTool({
  name: "grep",
  description: "在文件中搜索文本内容，支持正则表达式。自动利用项目索引加速。",
  schema: z.object({
    pattern: z.string().describe("搜索模式（支持正则表达式，如 'function.*getUser'）"),
    path: z.string().optional().describe("搜索根目录，默认当前目录"),
    max_results: z.number().optional().describe("最多返回结果数，默认 50"),
  }),
  func: async ({ pattern, path: searchPath, max_results }) => {
    try {
      const regex = new RegExp(pattern, 'gi');
      const max = max_results ?? 50;
      const indexedFiles = searchPath ? null : await getIndexedFiles();
      const results = indexedFiles
        ? await grepInFiles(indexedFiles, regex, max)
        : await recursiveGrep(searchPath || '.', regex, searchPath || '.', max);
      if (results.length === 0) return "未找到匹配。";
      return `找到 ${results.length} 处匹配:\n${results.join('\n')}`;
    } catch (err: any) {
      if (err instanceof SyntaxError) return `❌ 正则表达式无效: ${pattern}`;
      return `❌ 搜索失败: ${err.message}`;
    }
  },
});

// ============================================================
// 工具 ④：edit — 精确替换 + 自动更新索引
// ============================================================
export const editTool = new DynamicStructuredTool({
  name: "edit",
  description: "精确替换文件中的内容。修改后自动更新项目索引。",
  schema: z.object({
    file_path: z.string().describe("文件路径（绝对或相对路径）"),
    old_string: z.string().describe("被替换的原文（必须完全匹配，大小写敏感）"),
    new_string: z.string().describe("替换后的新内容"),
    replace_all: z.boolean().optional().describe("是否替换所有匹配项，默认只替换第一个"),
  }),
  func: async ({ file_path, old_string, new_string, replace_all }) => {
    if (old_string === new_string) return "❌ old_string 与 new_string 相同，无需修改。";

    try {
      const content = await fs.readFile(file_path, 'utf-8');

      if (!content.includes(old_string)) {
        try {
          const llm = createTempLLM();
          const res = await llm.invoke([
            new SystemMessage(
              `文件 ${file_path} 中未找到以下原文:\n\`\`\`\n${old_string}\n\`\`\`\n\n` +
              `请分析文件内容，找出最接近的匹配，并告诉我正确的原文应该是什么。\n\n文件内容:\n\`\`\`\n${content.substring(0, 3000)}\n\`\`\``
            ),
            new HumanMessage(`分析文件 ${file_path}，寻找与上述原文最接近的内容。`),
          ]);
          const suggestion = typeof res.content === 'string' ? res.content
            : res.content.map(c => ('text' in c ? c.text : '')).join('\n');
          return `❌ 在 ${file_path} 中未找到匹配的原文。\n\nLLM 分析建议:\n${suggestion}\n\n请先 read 确认文件内容后再试。`;
        } catch {
          return `❌ 在 ${file_path} 中未找到匹配的原文。请先 read 确认文件内容后再试。`;
        }
      }

      const newContent = replace_all
        ? content.replaceAll(old_string, new_string)
        : content.replace(old_string, new_string);

      await fs.writeFile(file_path, newContent, 'utf-8');

      // 更新索引
      const relPath = file_path.replace(/\\/g, '/');
      await updateFileIndex(relPath, newContent);

      const linesChanged = newContent.split('\n').length - content.split('\n').length;
      return `✅ 已修改 ${file_path}（${replace_all ? '全部替换' : '替换首个匹配'}，行数变化: ${linesChanged > 0 ? '+' : ''}${linesChanged}）\n📋 索引已更新。`;
    } catch (err: any) {
      if (err.code === 'ENOENT') return `❌ 文件不存在: ${file_path}`;
      return `❌ 编辑失败: ${err.message}`;
    }
  },
});

// ============================================================
// 工具 ⑤：write —— 整文件写入/新建（9/4 伤⑦）
//   修复闭环原来缺"新增文件"半边：edit 撞 ENOENT 直接 ❌，
//   用 bash heredoc 造文件在 Windows Git Bash 下是转义地狱。
//   规则：改已有文件优先 edit 精确替换，write 只用于新建文件或整体重写。
// ============================================================
export const writeTool = new DynamicStructuredTool({
  name: "write",
  description: "写入整个文件：不存在则新建（父目录自动创建），存在则整体覆盖。修改已有文件请优先用 edit 精确替换，只有新建文件或需要整体重写时才用 write。写入后自动更新索引。",
  schema: z.object({
    file_path: z.string().describe("文件路径（绝对或相对路径）"),
    content: z.string().describe("文件的完整内容"),
  }),
  func: async ({ file_path, content }) => {
    try {
      const abs = path.resolve(file_path);
      await fs.mkdir(path.dirname(abs), { recursive: true }); // 父目录自动补齐，新建深层路径文件不用先 mkdir
      let existed = true;
      try { await fs.stat(abs); } catch { existed = false; }
      await fs.writeFile(abs, content, 'utf-8');
      // 索引：无条目时 updateFileIndex 内部自动走 appendToIndex 追加
      await updateFileIndex(file_path.replace(/\\/g, '/'), content);
      const lineCount = content.split('\n').length;
      return `✅ 已${existed ? '整体覆盖' : '新建'} ${file_path}（${lineCount} 行）\n📋 索引已更新。`;
    } catch (err: any) {
      return `❌ 写入失败: ${err.message}`;
    }
  },
});

// ============================================================
// 导出
// ============================================================
export const Tools = [bashTool, readTool, grepTool, editTool, writeTool];