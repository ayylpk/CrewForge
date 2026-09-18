package com.hina.crewforge.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hina.crewforge.common.properties.JwtProperties;
import com.hina.crewforge.common.utils.JwtUtil;
import com.hina.crewforge.mapper.ProjectMapper;
import com.hina.crewforge.pojo.entity.Project;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 「验收与证据」端点的**端到端**集成测试：真 Spring 上下文（真 JWT 拦截器 + 真 Controller + 真 Service）
 * + 真库（sys_project / sys_task / sys_project_run）+ 真文件系统读取。
 *
 * 为什么值得起 Spring 上下文：单测能钉住解析逻辑，但钉不住「路由注册了吗 / 拦截器放行了吗 /
 * 归属锁生效了吗」—— 这三件恰好是新端点最容易出错的地方。
 *
 * 需要本机 MySQL 在跑（CrewForgeApplicationTests 同款依赖）。库里没有项目时按 Assumptions 跳过，
 * 不让"环境没数据"把测试判成失败。
 *
 * ⚠️ 类名刻意以 Test 结尾而不是 IT：本仓库没配 failsafe 插件，而 surefire 默认只匹配
 *    `*Test` / `*Tests` / `Test*` —— 叫 `...IT` 的话 `mvn test` 会**静默跳过**它。
 *    （9/18 实测：当时全量跑出 41 个测试，这个 IT 不在其中 —— 等于写了个永不执行的测试。）
 */
@SpringBootTest
@AutoConfigureMockMvc
class ProjectVerifyControllerTest {

    @Autowired
    private MockMvc mvc;

    @Autowired
    private JwtProperties jwtProperties;

    @Autowired
    private ProjectMapper projectMapper;

    /** 用后端自己的 JwtUtil 签 token —— 与登录链路同源，不会签出一个后端不认的东西 */
    private String tokenFor(long userId) {
        return JwtUtil.createJwt(jwtProperties.getUserSecretKey(), jwtProperties.getUserTtl(), userId);
    }

    private Project anyProject() {
        List<Project> list = projectMapper.selectList(new LambdaQueryWrapper<Project>().last("LIMIT 1"));
        return list.isEmpty() ? null : list.get(0);
    }

    @Test
    @DisplayName("无 token → 401（拦截器在控制器之前生效，接口不是裸奔的）")
    void requiresAuth() throws Exception {
        mvc.perform(get("/api/project-verify/1"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("自己的项目 → 200 且字段齐（真库 + 真产物树读取）")
    void returnsEvidenceForOwnProject() throws Exception {
        Project p = anyProject();
        Assumptions.assumeTrue(p != null, "库里的 sys_project 为空，跳过");

        mvc.perform(get("/api/project-verify/" + p.getId())
                        .header("Authorization", tokenFor(p.getCreateUser())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(1))
                .andExpect(jsonPath("$.data.projectId").value(p.getId()))
                // notes/taskEvidence/logTail 恒为数组（缺证据时用 notes 说明原因，不是报错）
                .andExpect(jsonPath("$.data.notes").isArray())
                .andExpect(jsonPath("$.data.taskEvidence").isArray())
                .andExpect(jsonPath("$.data.logTail").isArray())
                .andExpect(jsonPath("$.data.acceptance.files").isArray())
                .andExpect(jsonPath("$.data.acceptance.cases").isArray())
                // 进程账本恒有该 key（无账本时是空对象，不是 null）
                .andExpect(jsonPath("$.data.run").exists());
    }

    @Test
    @DisplayName("别人的项目 → 400 且 code=0（ProjectGuard 挡住 IDOR 读产物树）")
    void otherUsersProjectIsRejected() throws Exception {
        Project p = anyProject();
        Assumptions.assumeTrue(p != null, "库里的 sys_project 为空，跳过");

        long stranger = (p.getCreateUser() == null ? 1L : p.getCreateUser()) + 999L;
        mvc.perform(get("/api/project-verify/" + p.getId())
                        .header("Authorization", tokenFor(stranger)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value(0));
    }

    @Test
    @DisplayName("不存在的项目 → 400 且 code=0（先过存在性，再谈证据）")
    void missingProjectIsRejected() throws Exception {
        mvc.perform(get("/api/project-verify/999999999")
                        .header("Authorization", tokenFor(1L)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value(0));
    }
}
