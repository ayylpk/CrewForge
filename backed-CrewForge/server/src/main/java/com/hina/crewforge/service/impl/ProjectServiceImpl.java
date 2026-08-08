package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.pagehelper.Page;
import com.github.pagehelper.PageHelper;
import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.mapper.ProjectFileMapper;
import com.hina.crewforge.mapper.ProjectMapper;
import com.hina.crewforge.mapper.UserTenantMapper;
import com.hina.crewforge.pojo.entity.UserTenant;
import com.hina.crewforge.pojo.QueryParam.ProjectQueryParam;
import com.hina.crewforge.pojo.dto.ProjectDTO;
import com.hina.crewforge.pojo.entity.Project;
import com.hina.crewforge.pojo.entity.ProjectFile;
import com.hina.crewforge.pojo.vo.ProjectVO;
import com.hina.crewforge.service.ProjectService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.LocalDateTime;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
@Slf4j
public class ProjectServiceImpl extends ServiceImpl<ProjectMapper, Project> implements ProjectService {

    @Autowired
    private ProjectFileMapper projectFileMapper;
    @Autowired
    private UserTenantMapper userTenantMapper;
    @Autowired
    private ObjectMapper objectMapper;

    /**
     * 所有权校验（防 API 越权，与是否带 X-Tenant-Id 无关）：
     * · 个人项目: 只能操作自己创建的
     * · 团队项目: 必须是项目所属团队的成员(sys_user_tenant status=1)
     */
    private void checkOwnership(Project existing, String action) {
        Long currentUserId = BaseContext.getCurrentUserId();
        if (Project.PROJECT_TYPE_PERSONAL.equals(existing.getProjectType())) {
            if (!existing.getCreateUser().equals(currentUserId)) {
                throw new BaseException("无权" + action + "他人项目");
            }
            return;
        }
        Long cnt = userTenantMapper.selectCount(new LambdaQueryWrapper<UserTenant>()
                .eq(UserTenant::getUserId, currentUserId)
                .eq(UserTenant::getTenantId, existing.getTenantId())
                .eq(UserTenant::getStatus, 1));
        if (cnt == null || cnt == 0) {
            throw new BaseException("你不属于该项目所属团队，无权" + action);
        }
    }

    @Override
    public PageResult<ProjectVO> page(ProjectQueryParam projectQueryParam) {
        // 1. PageHelper 分页（只对紧接着的第一次查询生效）
        PageHelper.startPage(projectQueryParam.getPage(), projectQueryParam.getPageSize());

        // 2. 按查询类型拼过滤条件: 个人项目按 create_user(JWT 身份), 团队项目按 tenant_id
        LambdaQueryWrapper<Project> wrapper = new LambdaQueryWrapper<>();
        if (Project.PROJECT_TYPE_PERSONAL.equals(projectQueryParam.getProjectType())) {
            wrapper.eq(Project::getProjectType, Project.PROJECT_TYPE_PERSONAL);
            // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
            wrapper.eq(Project::getCreateUser, BaseContext.getCurrentUserId());
        } else if (Project.PROJECT_TYPE_TEAM.equals(projectQueryParam.getProjectType())) {
            wrapper.eq(Project::getProjectType, Project.PROJECT_TYPE_TEAM);
            if (projectQueryParam.getTenantId() != null) {
                wrapper.eq(Project::getTenantId, projectQueryParam.getTenantId());
            }
        }
        // 3. 关键词(项目名称) + 状态过滤
        if (StringUtils.hasText(projectQueryParam.getKeyword())) {
            wrapper.like(Project::getName, projectQueryParam.getKeyword());
        }
        if (StringUtils.hasText(projectQueryParam.getStatus())) {
            wrapper.eq(Project::getStatus, projectQueryParam.getStatus());
        }
        wrapper.orderByDesc(Project::getCreateTime);

        // 4. 组装返回(一次分组查本页所有项目的文件数, 避免 N+1)
        List<Project> list = baseMapper.selectList(wrapper);
        // PageHelper 拦截后返回的 List 实际是 Page 对象, 强转取 total
        Page<Project> p = (Page<Project>) list;
        Map<Long, Long> fileCounts = countProjectFiles(
                p.getResult().stream().map(Project::getId).collect(Collectors.toList()));
        List<ProjectVO> vos = p.getResult().stream().map(pr -> toVO(pr, fileCounts)).collect(Collectors.toList());
        return new PageResult<>(p.getTotal(), vos);
    }

    @Override
    public void create(ProjectDTO dto) {
        // 团队项目: 必须属于该团队才能往里建（防往任意团队塞项目）
        if (Project.PROJECT_TYPE_TEAM.equals(dto.getProjectType())) {
            Long cnt = userTenantMapper.selectCount(new LambdaQueryWrapper<UserTenant>()
                    .eq(UserTenant::getUserId, BaseContext.getCurrentUserId())
                    .eq(UserTenant::getTenantId, dto.getTenantId())
                    .eq(UserTenant::getStatus, 1));
            if (cnt == null || cnt == 0) {
                throw new BaseException("你不属于该团队，无法创建团队项目");
            }
        }
        Project project = new Project();
        BeanUtils.copyProperties(dto, project);
        LocalDateTime now = LocalDateTime.now();
        project.setCreateTime(now);
        project.setUpdateTime(now);
        // ⚠️ 不信任前端传的 createUser, 从 JWT 解析当前登录用户
        project.setCreateUser(BaseContext.getCurrentUserId());
        // 默认值: 个人项目 + 草稿状态 + 混合确认模式
        if (project.getProjectType() == null) {
            project.setProjectType(Project.PROJECT_TYPE_PERSONAL);
        }
        if (project.getStatus() == null) {
            project.setStatus("draft");
        }
        if (project.getConfirmMode() == null) {
            project.setConfirmMode(Project.CONFIRM_MODE_MIXED);
        }
        // TODO: 配额校验 (count(sys_project WHERE create_user=?) < sys_user.max_projects) 超了拒绝
        baseMapper.insert(project);
    }

    /** 项目状态合法值（与 sys_project.status 列注释一致） */
    private static final List<String> VALID_STATUS =
            List.of("draft", "clarifying", "planning", "executing", "paused", "done", "failed");

    @Override
    public void update(Long id, ProjectDTO dto) {
        // 1. 项目必须存在（防前端传错 id 静默失败）
        Project existing = baseMapper.selectById(id);
        if (existing == null) {
            throw new BaseException("项目不存在: " + id);
        }
        // 1.1 所有权校验: 个人项目只能改自己的; 团队项目必须是所属团队成员
        checkOwnership(existing, "修改");
        // 2. status 传了必须是合法值（防脏状态落库）
        if (StringUtils.hasText(dto.getStatus()) && !VALID_STATUS.contains(dto.getStatus())) {
            throw new BaseException("非法项目状态: " + dto.getStatus());
        }
        // 3. JSON 字符串字段传了必须是合法 JSON 数组（防脏数据落库）
        validateJsonArray(dto.getTechStack(), "techStack");
        validateJsonArray(dto.getDevPlan(), "devPlan");
        validateJsonArray(dto.getDirTree(), "dirTree");
        validateJsonArray(dto.getBusinessModules(), "businessModules");

        Project project = new Project();
        BeanUtils.copyProperties(dto, project);
        project.setId(id);
        project.setUpdateTime(LocalDateTime.now());
        // updateById 只更新非 null 字段（MyBatis-Plus 默认 NOT_NULL 策略，不会误覆盖没传的字段）
        baseMapper.updateById(project);
    }

    /** JSON 数组校验: 没传(null/空)不校验; 传了必须是合法 JSON 数组, 否则抛业务异常 */
    private void validateJsonArray(String json, String field) {
        if (!StringUtils.hasText(json)) {
            return;
        }
        try {
            JsonNode node = objectMapper.readTree(json);
            if (!node.isArray()) {
                throw new BaseException(field + " 必须是 JSON 数组");
            }
        } catch (Exception e) {
            if (e instanceof BaseException) {
                throw (BaseException) e;
            }
            throw new BaseException(field + " 不是合法 JSON");
        }
    }

    @Override
    public void delete(Long id) {
        // 1. 项目必须存在
        Project existing = baseMapper.selectById(id);
        if (existing == null) {
            throw new BaseException("项目不存在: " + id);
        }
        // 2. 所有权校验: 个人项目只能删自己的; 团队项目必须是所属团队成员
        checkOwnership(existing, "删除");
        // 3. 逻辑删除 (@TableLogic 自动转 deleted=1)
        baseMapper.deleteById(id);
    }

    @Override
    public ProjectVO getById(Long id) {
        Project project = baseMapper.selectById(id);
        Map<Long, Long> fileCounts = countProjectFiles(Collections.singletonList(id));
        return toVO(project, fileCounts);
    }

    private ProjectVO toVO(Project project, Map<Long, Long> fileCounts) {
        ProjectVO vo = new ProjectVO();
        BeanUtils.copyProperties(project, vo);
        vo.setFileCount(fileCounts.getOrDefault(project.getId(), 0L));
        vo.setModuleCount(parseModuleCount(project.getBusinessModules()));
        // TODO: 暂无任务表, 进度先返回 0; 待 sys_task 落地后按任务统计
        vo.setProgress(0);
        return vo;
    }

    /** 一次分组查询出多个项目的文件数(COUNT + GROUP BY project_id) */
    private Map<Long, Long> countProjectFiles(List<Long> projectIds) {
        Map<Long, Long> counts = new HashMap<>();
        if (projectIds.isEmpty()) {
            return counts;
        }
        QueryWrapper<ProjectFile> wrapper = new QueryWrapper<>();
        wrapper.select("project_id", "COUNT(*) AS file_cnt")
                .in("project_id", projectIds)
                .groupBy("project_id");
        for (Map<String, Object> row : projectFileMapper.selectMaps(wrapper)) {
            Long projectId = ((Number) row.get("project_id")).longValue();
            Long cnt = ((Number) row.get("file_cnt")).longValue();
            counts.put(projectId, cnt);
        }
        return counts;
    }

    /** 业务模块数 = businessModules JSON 数组长度, 解析失败按 0 */
    private Integer parseModuleCount(String businessModulesJson) {
        if (!StringUtils.hasText(businessModulesJson)) {
            return 0;
        }
        try {
            JsonNode node = objectMapper.readTree(businessModulesJson);
            return node.isArray() ? node.size() : 0;
        } catch (Exception e) {
            log.warn("解析 businessModules 失败: {}", e.getMessage());
            return 0;
        }
    }
}
