package com.hina.crewforge.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.ProjectFileMapper;
import com.hina.crewforge.mapper.ProjectMapper;
import com.hina.crewforge.mapper.TaskMapper;
import com.hina.crewforge.pojo.dto.ProjectDTO;
import com.hina.crewforge.pojo.entity.Project;
import com.hina.crewforge.service.impl.ProjectServiceImpl;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.test.util.ReflectionTestUtils;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.when;

/**
 * 「devPlan 必须是 JSON 数组」的回归测试（9/17 用户实测的真 bug）。
 *
 * 现场：项目详情/需求对话页读回整行、保存时又整行发回，而库里 dev_plan/tech_stack/
 * business_modules 有 19/12/13 行是**引擎写的信封对象**，旧校验只认数组 → 每次保存 400，
 * 表现为「功能清单存不进去 / 加不了功能」。
 *
 * 两道防线各自有测试：
 *   1. 本测试 —— 后端必须接受系统自己产出的形状（数组或对象），只拒标量与坏 JSON；
 *   2. CreateProjectView 的"只发我编辑的字段" —— 前端不再整行往返（无单测，靠 vue-tsc + 代码审查）。
 *
 * 纯单测：mock mapper，不起 Spring、不碰数据库。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ProjectServiceImplJsonShapeTest {

    private static final Long ME = 1001L;
    private static final Long PROJECT_ID = 20L;

    @Mock private ProjectMapper projectMapper;
    @Mock private ProjectFileMapper projectFileMapper;
    @Mock private TaskMapper taskMapper;

    private ProjectServiceImpl service;

    @BeforeEach
    void setUp() {
        BaseContext.setCurrentUserId(ME);
        service = new ProjectServiceImpl();
        ReflectionTestUtils.setField(service, "baseMapper", projectMapper);
        ReflectionTestUtils.setField(service, "projectFileMapper", projectFileMapper);
        ReflectionTestUtils.setField(service, "taskMapper", taskMapper);
        ReflectionTestUtils.setField(service, "objectMapper", new ObjectMapper());

        Project existing = new Project();
        existing.setId(PROJECT_ID);
        existing.setCreateUser(ME);
        when(projectMapper.selectById(PROJECT_ID)).thenReturn(existing);
    }

    @AfterEach
    void tearDown() {
        BaseContext.remove();
    }

    @Test
    @DisplayName("引擎写的信封对象必须被接受（devPlan/techStack/businessModules 三列实测都是对象）")
    void engineEnvelopeObjectsAreAccepted() {
        ProjectDTO dto = new ProjectDTO();
        // 键值取自现网真样本（sys_project 里 19/12/13 行就是这个形状）
        dto.setDevPlan("{\"risks\":[\"a\"],\"phases\":[{\"phase\":1,\"name\":\"地基\"}],\"project\":{},"
                + "\"features\":[],\"mvp_scope\":[],\"uiProfile\":{}}");
        dto.setTechStack("{\"why\":\"延续阶段1选型\",\"tables\":[],\"moduleTech\":[],\"techniques\":[\"Vue 3\"]}");
        dto.setBusinessModules("{\"risks\":[],\"modules\":[{\"name\":\"待办接口模块\",\"points\":[]}],"
                + "\"summary\":\"\",\"deliverables\":[]}");

        assertDoesNotThrow(() -> service.update(PROJECT_ID, dto),
                "引擎产出的信封形状不该被校验打成 400 —— 这正是「功能清单存不进去」的真因");
    }

    @Test
    @DisplayName("网页写的裸数组仍然接受（双形状都要活）")
    void plainArraysStillAccepted() {
        ProjectDTO dto = new ProjectDTO();
        dto.setTechStack("[\"Vue 3\",\"Spring Boot\"]");
        dto.setDevPlan("[{\"name\":\"阶段一\",\"progress\":0,\"tasks\":[]}]");
        dto.setDirTree("[{\"name\":\"backend\",\"type\":\"dir\"}]");
        dto.setBusinessModules("[\"报表导出 Excel\"]");

        assertDoesNotThrow(() -> service.update(PROJECT_ID, dto));
    }

    @Test
    @DisplayName("标量与坏 JSON 仍然要挡住（校验放宽的是形状，不是底线）")
    void scalarsAndBrokenJsonAreStillRejected() {
        ProjectDTO scalar = new ProjectDTO();
        scalar.setDevPlan("123"); // 合法 JSON，但不是数组也不是对象
        BaseException e1 = assertThrows(BaseException.class, () -> service.update(PROJECT_ID, scalar));
        assertEquals("devPlan 必须是 JSON 数组或对象", e1.getMessage());

        ProjectDTO broken = new ProjectDTO();
        broken.setTechStack("[\"Vue 3\""); // 截断的 JSON
        BaseException e2 = assertThrows(BaseException.class, () -> service.update(PROJECT_ID, broken));
        assertEquals("techStack 不是合法 JSON", e2.getMessage());
    }

    @Test
    @DisplayName("不传（null/空）不做形状校验，只更新传了的字段")
    void nullFieldsAreSkipped() {
        ProjectDTO dto = new ProjectDTO();
        dto.setConfirmMode(1);
        assertDoesNotThrow(() -> service.update(PROJECT_ID, dto));
    }
}
