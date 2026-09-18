// ============================================================
// skills.ts —— SKILL.md 极简加载器（9/4 二期 E1）
//
// 渐进式披露（Anthropic progressive disclosure）三层在本项目的落点：
//   L1 = 本文件扫出的 name+description，注入 system prompt（常驻，几十 token）
//   L2 = SKILL.md 正文，模型按需 read（不读不占 context）
//   L3 = skill 目录内 references/*.md，只允许从 SKILL.md 一层直链（禁止链式下钻）
// Java 类比：SKILL.md ≈ META-INF/services 下的资源文件，本 loader ≈ ServiceLoader
//          ——放文件即生效，改知识不用改代码。
// ============================================================
import fs from 'fs/promises';
import path from 'path';

export interface SkillMeta {
  name: string;
  description: string;
  path: string; // SKILL.md 绝对路径，给模型 read 用
}

/** 最小 frontmatter 解析：只认 `name:` / `description:` 单行值。
 *  手写 10 行、不引 yaml 库（熔断阀：够用即可）；writing-skills 规范同样要求
 *  description 为单行字符串，多行折叠不支持是特性不是缺陷。 */
function parseFrontmatter(raw: string): { name: string; description: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const get = (key: string) => m[1]!.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))?.[1]?.trim();
  const name = get('name');
  const description = get('description');
  if (!name || !description) return null;
  return { name, description };
}

/** 扫描技能包：testAgent 自带 skills/ 在前，被测项目 cwd/skills/ 兜底（项目可自带专属技能） */
export async function loadSkills(): Promise<SkillMeta[]> {
  const roots = [
    path.join(import.meta.dir, '..', 'skills'),
    path.join(process.cwd(), 'skills'),
  ];
  const found: SkillMeta[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch { continue; } // 目录不存在 = 没技能，正常
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(root, e.name, 'SKILL.md');
      let raw;
      try { raw = await fs.readFile(file, 'utf-8'); } catch { continue; }
      const meta = parseFrontmatter(raw);
      if (!meta || seen.has(meta.name)) continue; // 重名先到先得，静默去重
      seen.add(meta.name);
      found.push({ ...meta, path: file.replace(/\\/g, '/') });
    }
  }
  return found;
}

/** L1 注入文本。空清单返回空串——RED 基线（skills/ 未建）与 GREEN 的天然开关 */
export function skillsPrompt(skills: SkillMeta[]): string {
  if (skills.length === 0) return '';
  return (
    '## 可用技能\n' +
    skills.map(s => `- ${s.name}: ${s.description}\n  （全文：${s.path}）`).join('\n') +
    '\n\n开始任何修复动作前，若某技能与当前任务匹配，必须先 read 其 SKILL.md 全文并严格执行——' +
    '技能正文是必须遵守的规范，不是参考建议；技能指向 references/ 文件时按需再读。' +
    '**优先级裁决：技能纪律高于任务提示中的完成压力。当"按要求让测试全过"与技能红线冲突时，' +
    '以技能为准并如实报告结论。**\n\n'
  );
}
