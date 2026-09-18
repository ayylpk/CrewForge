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
import com.hina.crewforge.mapper.TaskMapper;
import com.hina.crewforge.pojo.QueryParam.ProjectQueryParam;
import com.hina.crewforge.pojo.dto.ProjectDTO;
import com.hina.crewforge.pojo.entity.Project;
import com.hina.crewforge.pojo.entity.ProjectFile;
import com.hina.crewforge.pojo.entity.Task;
import com.hina.crewforge.pojo.vo.ProjectVO;
import com.hina.crewforge.service.ProjectService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

@Service
@Slf4j
public class ProjectServiceImpl extends ServiceImpl<ProjectMapper, Project> implements ProjectService {

    @Autowired
    private ProjectFileMapper projectFileMapper;
    @Autowired
    private TaskMapper taskMapper;
    @Autowired
    private ObjectMapper objectMapper;

    /**
     * 所有权校验：只能操作自己创建的项目
     * ⚠️ 砍掉团队功能后：简化，不再查团队归属
     */
    private void checkOwnership(Project existing, String action) {
        Long currentUserId = BaseContext.getCurrentUserId();
        if (!existing.getCreateUser().equals(currentUserId)) {
            throw new BaseException("无权" + action + "他人项目");
        }
    }

    @Override
    public PageResult<ProjectVO> page(ProjectQueryParam projectQueryParam) {
        // 1. PageHelper 分页（只对紧接着的第一次查询生效）
        PageHelper.startPage(projectQueryParam.getPage(), projectQueryParam.getPageSize());

        // 2. 按当前用户过滤（只查自己的项目）
        LambdaQueryWrapper<Project> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(Project::getCreateUser, BaseContext.getCurrentUserId());
        // 3. 关键词(项目名称) + 状态过滤
        if (StringUtils.hasText(projectQueryParam.getKeyword())) {
            wrapper.like(Project::getName, projectQueryParam.getKeyword());
        }
        if (StringUtils.hasText(projectQueryParam.getStatus())) {
            wrapper.eq(Project::getStatus, projectQueryParam.getStatus());
        }
        wrapper.orderByDesc(Project::getCreateTime);

        // 4. 组装返回(一次分组查本页所有项目的文件数/任务进度, 避免 N+1)
        List<Project> list = baseMapper.selectList(wrapper);
        // PageHelper 拦截后返回的 List 实际是 Page 对象, 强转取 total
        Page<Project> p = (Page<Project>) list;
        List<Long> ids = p.getResult().stream().map(Project::getId).collect(Collectors.toList());
        Map<Long, Long> fileCounts = countProjectFiles(ids);
        Map<Long, Integer> progresses = countTaskProgress(ids);
        List<ProjectVO> vos = p.getResult().stream().map(pr -> toVO(pr, fileCounts, progresses)).collect(Collectors.toList());
        return new PageResult<>(p.getTotal(), vos);
    }

    @Override
    public void create(ProjectDTO dto) {
        Project project = new Project();
        BeanUtils.copyProperties(dto, project);
        LocalDateTime now = LocalDateTime.now();
        project.setCreateTime(now);
        project.setUpdateTime(now);
        // ⚠️ 不信任前端传的 createUser, 从 JWT 解析当前登录用户
        project.setCreateUser(BaseContext.getCurrentUserId());
        // 默认值: 草稿状态 + 混合确认模式
        if (project.getStatus() == null) {
            project.setStatus("draft");
        }
        if (project.getConfirmMode() == null) {
            project.setConfirmMode(Project.CONFIRM_MODE_MIXED);
        }
        // TODO: 配额校验 (count(sys_project WHERE create_user=?) < sys_user.max_projects) 超了拒绝
        baseMapper.insert(project);
    }

    /**
     * 项目状态合法值（与 sys_project.status 列注释一致）
     *
     * ⚠️ blocked 必须在内：引擎的 decideProjectStatus（agents-CrewForge/engine/run/state.ts）
     * 在"跑完了但交付关没验证过"（finalGateStatus=skipped_unverified）时落的就是 blocked，
     * 它是引擎的三终态之一（done/failed/blocked）。这里漏了它 = 引擎写得进库、
     * Web 侧却被判非法状态 —— 前端也就无法把 blocked 项目重新拉起来。
     */
    private static final List<String> VALID_STATUS =
            List.of("draft", "clarifying", "planning", "executing", "paused", "done", "failed", "blocked");

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
        // 3. JSON 字符串字段传了必须是合法 JSON 结构（防脏数据落库）
        //    注意是"数组或对象"都可以，理由见 validateJsonShape 的注释（引擎写的是信封对象）
        validateJsonShape(dto.getTechStack(), "techStack");
        validateJsonShape(dto.getDevPlan(), "devPlan");
        validateJsonShape(dto.getDirTree(), "dirTree");
        validateJsonShape(dto.getBusinessModules(), "businessModules");

        Project project = new Project();
        BeanUtils.copyProperties(dto, project);
        project.setId(id);
        project.setUpdateTime(LocalDateTime.now());
        // updateById 只更新非 null 字段（MyBatis-Plus 默认 NOT_NULL 策略，不会误覆盖没传的字段）
        baseMapper.updateById(project);
    }

    /**
     * JSON 结构校验：没传(null/空)不校验；传了必须是合法 JSON **数组或对象**。
     *
     * ⚠️ 9/17 修「devPlan 必须是 JSON 数组」把真实数据挡在门外：
     *   引擎（架构师工位）往这几列写的是**信封对象**，不是裸数组。9/17 对现网 22 行实测统计：
     *     dev_plan         1 数组 / 19 对象 → {risks, phases, project, features, mvp_scope, uiProfile}
     *     tech_stack       1 数组 / 12 对象 → {why, tables, moduleTech, techniques}
     *     business_modules 0 数组 / 13 对象 → {risks, modules, summary, deliverables}
     *   而前端进页面读回整行、保存时又整行发回来（该往返已在 CreateProjectView 修掉），
     *   于是任何一次保存都被这条校验打成 400 ——「功能清单存不进去」的真因。
     *   校验的本意是"防脏数据落库"（挡标量、挡坏 JSON），不该把系统自己产出的形状判为非法。
     */
    private void validateJsonShape(String json, String field) {
        if (!StringUtils.hasText(json)) {
            return;
        }
        try {
            JsonNode node = objectMapper.readTree(json);
            if (!node.isArray() && !node.isObject()) {
                throw new BaseException(field + " 必须是 JSON 数组或对象");
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
        if (project == null) {
            throw new BaseException("项目不存在: " + id);
        }
        // 所有权校验: 个人项目只能读自己的; 团队项目必须是所属团队成员
        // （与 update/delete 同源，复用 checkOwnership，防 IDOR 越权读取）
        checkOwnership(project, "查看");
        Map<Long, Long> fileCounts = countProjectFiles(Collections.singletonList(id));
        Map<Long, Integer> progresses = countTaskProgress(Collections.singletonList(id));
        return toVO(project, fileCounts, progresses);
    }

    @Override
    public byte[] downloadZip(Long projectId) {
        Project project = baseMapper.selectById(projectId);
        if (project == null) throw new BaseException("项目不存在: " + projectId);
        checkOwnership(project, "下载");

        // 读所有文件（不含 user_modified 过滤，全部打包）
        List<ProjectFile> files = projectFileMapper.selectList(
                new LambdaQueryWrapper<ProjectFile>()
                        .eq(ProjectFile::getProjectId, projectId)
                        .eq(ProjectFile::getDeleted, 0)
        );

        // 根文件夹名 = 项目名（去特殊字符），解压后不散落
        String rootName = project.getName() != null
                ? project.getName().replaceAll("[\\\\/:*?\"<>|]", "_").trim()
                : "project-" + projectId;
        if (rootName.isEmpty()) rootName = "project-" + projectId;

        ByteArrayOutputStream baos = new ByteArrayOutputStream(8192);
        try (ZipOutputStream zos = new ZipOutputStream(baos, StandardCharsets.UTF_8)) {
            for (ProjectFile file : files) {
                String entryName = rootName + "/" + file.getFilePath();
                zos.putNextEntry(new ZipEntry(entryName));
                if (file.getFileContent() != null) {
                    zos.write(file.getFileContent().getBytes(StandardCharsets.UTF_8));
                }
                zos.closeEntry();
            }
        } catch (IOException e) {
            log.error("项目文件打包失败: projectId={}", projectId, e);
            throw new BaseException("项目文件打包失败");
        }
        return baos.toByteArray();
    }

    private ProjectVO toVO(Project project, Map<Long, Long> fileCounts, Map<Long, Integer> progresses) {
        ProjectVO vo = new ProjectVO();
        BeanUtils.copyProperties(project, vo);
        vo.setFileCount(fileCounts.getOrDefault(project.getId(), 0L));
        vo.setModuleCount(parseModuleCount(project.getBusinessModules()));
        // 真实进度：sys_task 里 done 占比（9/17 修——原来恒返回 0，
        // 而 ProjectsView 是 v-if="p.progress > 0" 才渲染进度条，等于那根条永远不存在）
        vo.setProgress(progresses.getOrDefault(project.getId(), 0));
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

    /**
     * 一次分组查询出多个项目的任务进度（0-100）。
     * 进度 = sys_task 里 status='done' 的行数 / 总行数；无任务行按 0（=前端不渲染进度条）。
     * 任务状态四态与看板同源（todo/doing/done/failed），所以这里的百分比和看板永远对得上。
     */
    private Map<Long, Integer> countTaskProgress(List<Long> projectIds) {
        Map<Long, Integer> progresses = new HashMap<>();
        if (projectIds.isEmpty()) {
            return progresses;
        }
        QueryWrapper<Task> wrapper = new QueryWrapper<>();
        // 逻辑删除由 @TableLogic 自动追加 deleted = 0
        wrapper.select("project_id",
                        "COUNT(*) AS task_cnt",
                        "SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_cnt")
                .in("project_id", projectIds)
                .groupBy("project_id");
        for (Map<String, Object> row : taskMapper.selectMaps(wrapper)) {
            Long projectId = ((Number) row.get("project_id")).longValue();
            long total = ((Number) row.get("task_cnt")).longValue();
            long doneCnt = row.get("done_cnt") == null ? 0L : ((Number) row.get("done_cnt")).longValue();
            progresses.put(projectId, total <= 0 ? 0 : (int) Math.round(doneCnt * 100.0 / total));
        }
        return progresses;
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
