package com.hina.crewforge.service.impl;

import com.github.pagehelper.Page;
import com.github.pagehelper.PageHelper;
import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.mapper.AgentPoolMapper;
import com.hina.crewforge.mapper.ProjectAgentMapper;
import com.hina.crewforge.pojo.QueryParam.ProjectAgentQueryParam;
import com.hina.crewforge.pojo.dto.ProjectAgentCopyDTO;
import com.hina.crewforge.pojo.dto.ProjectAgentDTO;
import com.hina.crewforge.pojo.entity.AgentPool;
import com.hina.crewforge.pojo.entity.ProjectAgent;
import com.hina.crewforge.pojo.vo.ProjectAgentVO;
import com.hina.crewforge.service.ProjectAgentService;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

@Service
public class ProjectAgentServiceImpl implements ProjectAgentService {

    @Autowired
    private ProjectAgentMapper projectAgentMapper;

    @Autowired
    private AgentPoolMapper agentPoolMapper;

    @Override
    public PageResult<ProjectAgentVO> page(ProjectAgentQueryParam projectAgentQueryParam) {
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        projectAgentQueryParam.setUserId(BaseContext.getCurrentUserId());
        PageHelper.startPage(projectAgentQueryParam.getPage(),projectAgentQueryParam.getPageSize());

        List<ProjectAgent> list = projectAgentMapper.list(projectAgentQueryParam);
        Page<ProjectAgent> p = (Page<ProjectAgent>)list;

        List<ProjectAgentVO> voList = p.getResult().stream().map(this::toVO).collect(Collectors.toList());

        return new PageResult<>(p.getTotal(),voList);
    }

    @Override
    public List<ProjectAgentVO> listAll(Long projectId) {
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        Long userId = BaseContext.getCurrentUserId();
        List<ProjectAgent> list = projectAgentMapper.listAll(projectId, userId);
        return list.stream().map(this::toVO).collect(Collectors.toList());
    }

    /** 空字符串转 null：tools 是 JSON 列不能存 ''；model 空串=跟随全局（存 NULL） */
    private void normalize(ProjectAgent entity) {
        if (entity.getTools() != null && entity.getTools().trim().isEmpty()) {
            entity.setTools(null);
        }
        if (entity.getModel() != null && entity.getModel().trim().isEmpty()) {
            entity.setModel(null);
        }
    }

    @Override
    public void create(ProjectAgentDTO dto) {
        ProjectAgent entity = new ProjectAgent();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        LocalDateTime now = LocalDateTime.now();
        entity.setCreateTime(now);
        entity.setUpdateTime(now);
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        entity.setUserId(BaseContext.getCurrentUserId());
        // 加入项目默认参与
        if (entity.getStatus() == null) {
            entity.setStatus(1);
        }
        projectAgentMapper.insert(entity);
    }

    @Override
    public void update(Long id, ProjectAgentDTO dto) {
        // 1. 存在 + 所有权校验（项目 Agent 按用户隔离, 只能改自己的）
        ProjectAgent existing = projectAgentMapper.getById(id);
        if (existing == null) {
            throw new BaseException("项目 Agent 不存在: " + id);
        }
        if (!existing.getUserId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权修改他人的项目 Agent");
        }
        // 2. 更新（userId 不允许改, 覆盖为原值）
        ProjectAgent entity = new ProjectAgent();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        entity.setId(id);
        entity.setUserId(existing.getUserId());
        entity.setUpdateTime(LocalDateTime.now());
        projectAgentMapper.updateById(entity);
    }

    @Override
    public ProjectAgentVO getById(Long id) {
        ProjectAgent entity = projectAgentMapper.getById(id);
        return toVO(entity);
    }

    @Override
    public void deleteByIds(String ids) {
        // 格式: "projectId-id1-id2-id3" —— projectId 仅作过滤, userId 从 JWT 取(防删别人的)
        String[] parts = ids.split("-");
        Long projectId = Long.parseLong(parts[0]);
        List<Long> idList = new ArrayList<>();
        for (int i = 1; i < parts.length; i++) {
            idList.add(Long.parseLong(parts[i]));
        }
        projectAgentMapper.deleteByIds(idList, projectId, BaseContext.getCurrentUserId(), LocalDateTime.now());
    }

    /**
     * 从 Agent 池复制到项目团队（复制非引用：改池不影响已复制的成员）
     * 一个事务：查池 → 逐条复制字段 → 批量插入，全成或全败
     */
    @Override
    @Transactional
    public int copyFromPool(ProjectAgentCopyDTO dto) {
        if (dto.getAgentIds() == null || dto.getAgentIds().isEmpty()) {
            return 0;
        }
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        Long currentUserId = BaseContext.getCurrentUserId();
        // 池里的 Agent 只允许复制自己的（防拿别人的池模板）
        List<AgentPool> pool = agentPoolMapper.selectByIds(dto.getAgentIds()).stream()
                .filter(p -> p.getUserId().equals(currentUserId))
                .collect(Collectors.toList());
        LocalDateTime now = LocalDateTime.now();
        int count = 0;
        for (AgentPool p : pool) {
            ProjectAgent entity = new ProjectAgent();
            entity.setProjectId(dto.getProjectId());
            entity.setUserId(currentUserId);
            entity.setName(p.getName());
            entity.setRole(p.getRole());
            entity.setSystemPrompt(p.getSystemPrompt());
            entity.setTools(p.getTools());
            entity.setModel(p.getModel());
            entity.setTemperature(p.getTemperature());
            // 拉取进项目默认参与
            entity.setStatus(1);
            entity.setCreateTime(now);
            entity.setUpdateTime(now);
            projectAgentMapper.insert(entity);
            count++;
        }
        return count;
    }

    private ProjectAgentVO toVO(ProjectAgent projectAgent) {
        ProjectAgentVO vo = new ProjectAgentVO();
        BeanUtils.copyProperties(projectAgent,vo);
        return vo;
    }
}
