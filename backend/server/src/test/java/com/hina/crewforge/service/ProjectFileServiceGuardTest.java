package com.hina.crewforge.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.ProjectFileMapper;
import com.hina.crewforge.mapper.ProjectMapper;
import com.hina.crewforge.pojo.dto.ProjectFileDTO;
import com.hina.crewforge.pojo.entity.Project;
import com.hina.crewforge.pojo.entity.ProjectFile;
import com.hina.crewforge.service.impl.ProjectFileServiceImpl;
import com.hina.crewforge.service.support.ProjectGuard;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

/**
 * 审计漏洞① 的回归测试：ProjectFileServiceImpl 的 list/create/update 没过 ProjectGuard（IDOR 越权）
 *
 * 设计口径（对齐 9/15 夜审计）：
 * - guard 用【真实 ProjectGuard + mock ProjectMapper】，不 mock guard 本身——
 *   如果 service 忘了调锁，这里会直接红；mock 掉 guard 的写法测的是"mock 自己"，防不住这个。
 * - 归属口径 = 仅创建者（checkOwnership 已随团队功能砍掉而简化），与 getById 现行为同源。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ProjectFileServiceGuardTest {

    private static final Long ME = 1001L;    // 当前登录用户
    private static final Long OTHER = 2002L; // 别人
    private static final Long MY_PROJECT = 10L;
    private static final Long OTHER_PROJECT = 20L;

    @Mock private ProjectFileMapper fileMapper;
    @Mock private ProjectMapper projectMapper;
    @Mock private StringRedisTemplate redisTemplate;
    @Mock private ValueOperations<String, String> valueOps;
    @Mock private ProjectService projectService;

    private ProjectFileServiceImpl service;

    @BeforeEach
    void setUp() {
        // 纯单测环境没有 MP 启动流程，LambdaQueryWrapper.select() 需要实体 TableInfo 缓存，手动预热
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(new MybatisConfiguration(), "");
        TableInfoHelper.initTableInfo(assistant, ProjectFile.class);
        TableInfoHelper.initTableInfo(assistant, Project.class);
        BaseContext.setCurrentUserId(ME);
        service = new ProjectFileServiceImpl();
        // 真实门卫：项目查得到查不到、归谁，全由 mock projectMapper 的桩决定
        ProjectGuard realGuard = new ProjectGuard(projectMapper);
        ReflectionTestUtils.setField(service, "baseMapper", fileMapper);
        ReflectionTestUtils.setField(service, "projectGuard", realGuard);
        ReflectionTestUtils.setField(service, "projectService", projectService);
        ReflectionTestUtils.setField(service, "redisTemplate", redisTemplate);
        ReflectionTestUtils.setField(service, "objectMapper", new ObjectMapper());
        when(redisTemplate.opsForValue()).thenReturn(valueOps);
        when(valueOps.get(anyString())).thenReturn(null); // 永远缓存未命中，走回源路径
    }

    @AfterEach
    void tearDown() {
        BaseContext.remove();
    }

    /** 往 mock 的 ProjectMapper 里放项目：exist=存在，owner=归属人 */
    private void stubProject(Long projectId, Long owner) {
        Project p = new Project();
        p.setId(projectId);
        p.setCreateUser(owner);
        when(projectMapper.selectById(projectId)).thenReturn(p);
    }

    // ==================== list ====================

    @Test
    @DisplayName("list: 查别人项目的文件列表必须被拒（审计漏洞① 主体）")
    void listRejectsForeignProject() {
        stubProject(OTHER_PROJECT, OTHER);
        assertThrows(BaseException.class, () -> service.listByProjectId(OTHER_PROJECT));
        // 被拒时不应触达文件表——防"先查了再拒绝"（数据已进缓存/日志的侧面泄漏）
        verify(fileMapper, never()).selectList(any());
    }

    @Test
    @DisplayName("list: 自己的项目正常返回")
    void listAllowsOwnProject() {
        stubProject(MY_PROJECT, ME);
        when(fileMapper.selectList(any())).thenReturn(List.of());
        assertDoesNotThrow(() -> service.listByProjectId(MY_PROJECT));
    }

    @Test
    @DisplayName("list: 不存在的projectId同样被拒（guard 口径=不存在即拒绝）")
    void listRejectsUnknownProject() {
        when(projectMapper.selectById(999L)).thenReturn(null);
        assertThrows(BaseException.class, () -> service.listByProjectId(999L));
    }

    // ==================== update ====================

    @Test
    @DisplayName("update: 改别人项目下的文件必须被拒")
    void updateRejectsFileInForeignProject() {
        ProjectFile file = file(5L, OTHER_PROJECT);
        when(fileMapper.selectById(5L)).thenReturn(file);
        stubProject(OTHER_PROJECT, OTHER);
        assertThrows(BaseException.class, () -> service.update(5L, new ProjectFileDTO()));
        verify(fileMapper, never()).updateById(any(ProjectFile.class));
    }

    @Test
    @DisplayName("update: dto.projectId 想把文件改挂到别人项目 → 拒绝（审计点名：DTO直拷projectId）")
    void updateRejectsReparentingToForeignProject() {
        ProjectFile file = file(5L, MY_PROJECT);          // 文件在我项目下
        when(fileMapper.selectById(5L)).thenReturn(file);
        stubProject(MY_PROJECT, ME);
        stubProject(OTHER_PROJECT, OTHER);
        ProjectFileDTO dto = new ProjectFileDTO();
        dto.setProjectId(OTHER_PROJECT);                   // 想把 projectId 改成别人的
        assertThrows(BaseException.class, () -> service.update(5L, dto));
        verify(fileMapper, never()).updateById(any(ProjectFile.class));
    }

    @Test
    @DisplayName("update: 文件不存在 → 明确报错，不再静默成功")
    void updateRejectsMissingFile() {
        when(fileMapper.selectById(404L)).thenReturn(null);
        assertThrows(BaseException.class, () -> service.update(404L, new ProjectFileDTO()));
    }

    @Test
    @DisplayName("update: 自己项目内的正常编辑路径不受影响（userModified=1 + 清缓存）")
    void updateOwnFileStillWorks() {
        ProjectFile file = file(5L, MY_PROJECT);
        when(fileMapper.selectById(5L)).thenReturn(file);
        stubProject(MY_PROJECT, ME);
        ProjectFileDTO dto = new ProjectFileDTO();
        dto.setFileContent("console.log(1)");
        dto.setProjectId(MY_PROJECT);                      // 同项目回传（前端整对象 PUT 的真实形状）
        service.update(5L, dto);
        verify(fileMapper).updateById(argThat((ProjectFile u) ->
                Integer.valueOf(1).equals(u.getUserModified())));
        verify(redisTemplate).delete("pf:list:" + MY_PROJECT); // 缓存被清
    }

    // ==================== create ====================

    @Test
    @DisplayName("create: 往别人项目下写文件必须被拒（同类 IDOR，审计虽只点名 list/update，但锁同一条）")
    void createRejectsForeignProject() {
        stubProject(OTHER_PROJECT, OTHER);
        ProjectFileDTO dto = new ProjectFileDTO();
        dto.setProjectId(OTHER_PROJECT);
        dto.setFilePath("src/a.ts");
        assertThrows(BaseException.class, () -> service.create(dto));
        verify(fileMapper, never()).insert(any(ProjectFile.class));
        verify(fileMapper, never()).updateById(any(ProjectFile.class));
    }

    @Test
    @DisplayName("create: 自己项目下正常写入")
    void createOwnProjectStillWorks() {
        stubProject(MY_PROJECT, ME);
        when(fileMapper.selectOne(any())).thenReturn(null); // 路径不存在 → 走 insert
        ProjectFileDTO dto = new ProjectFileDTO();
        dto.setProjectId(MY_PROJECT);
        dto.setFilePath("src/a.ts");
        assertDoesNotThrow(() -> service.create(dto));
        verify(fileMapper).insert(any(ProjectFile.class));
    }

    private static ProjectFile file(Long id, Long projectId) {
        ProjectFile f = new ProjectFile();
        f.setId(id);
        f.setProjectId(projectId);
        f.setFilePath("src/a.ts");
        return f;
    }
}
