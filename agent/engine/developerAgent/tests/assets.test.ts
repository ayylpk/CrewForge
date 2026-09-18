import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";

const ROOT = path.resolve(import.meta.dir, "../assets");
const EXPECTED = [
    ["backend", "springboot"],
    ["backend", "express"],
    ["frontend", "vue"],
    ["database", "mysql"],
] as const;

describe("assets / 独立技术资产", () => {
    it("catalog 注册 Spring Boot、Vue、MySQL 三个独立资产", () => {
        const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog.json"), "utf-8"));
        const ids = catalog.assets.map((x: { id: string }) => x.id);
        for (const id of ["express", "mysql", "springboot", "vue", "element-plus", "tdesign-vue-next"]) {
            expect(ids).toContain(id);
        }
        expect(catalog.assets.every((x: { path: string }) => !x.path.includes("springboot-vue"))).toBe(true);
    });

    it("两个 UI 资产是独立可选项，互相冲突但不复制库源码", () => {
        for (const id of ["element-plus", "tdesign-vue-next"]) {
            const dir = path.join(ROOT, "frontend-ui", id);
            const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
            expect(manifest.kind).toBe("frontend-ui");
            expect(manifest.files.length).toBeGreaterThan(0);
            expect(manifest.conflicts.length).toBe(1);
            expect(fs.existsSync(path.join(dir, "package-fragment.json"))).toBe(true);
            expect(fs.existsSync(path.join(dir, "integration", "main.ts.snippet"))).toBe(true);
            expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);
        }
    });

    for (const [kind, id] of EXPECTED) {
        it(`${id} 摘要可渐进披露且 manifest/模板完整`, () => {
            const dir = path.join(ROOT, kind, id);
            const summary = fs.readFileSync(path.join(dir, "summary.md"), "utf-8").trim().split(/\r?\n/);
            expect(summary.length).toBeLessThanOrEqual(20);
            const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
            expect(manifest.schemaVersion).toBe("crewforge.asset/v1");
            expect(manifest.id).toBe(id);
            expect(manifest.kind).toBe(kind);
            expect(manifest.provides.length).toBeGreaterThan(0);
            expect(Array.isArray(manifest.requires)).toBe(true);
            expect(manifest.files.length).toBeGreaterThan(0);
            for (const file of manifest.files) {
                expect(fs.existsSync(path.join(dir, file.source))).toBe(true);
                expect(typeof file.target).toBe("string");
            }
            expect(manifest.validation.commands.length).toBeGreaterThan(0);
        });
    }

    it("Vue 路由扩展点必须是可执行占位符，不能被注释吞掉", () => {
        const source = fs.readFileSync(path.join(ROOT, "frontend/vue/template/router.ts.tpl"), "utf-8");
        expect(source).toContain("    {{APP_ROUTES}}");
        expect(source).not.toContain("// {{APP_ROUTES}}");
    });
});
