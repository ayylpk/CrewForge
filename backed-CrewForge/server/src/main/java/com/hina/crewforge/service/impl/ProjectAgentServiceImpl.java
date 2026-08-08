package com.hina.crewforge.service.impl;

import com.github.pagehelper.Page;
import com.github.pagehelper.PageHelper;
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
        PageHelper.startPage(projectAgentQueryParam.getPage(),projectAgentQueryParam.getPageSize());

        List<ProjectAgent> list = projectAgentMapper.list(projectAgentQueryParam);
        Page<ProjectAgent> p = (Page<ProjectAgent>)list;

        List<ProjectAgentVO> voList = p.getResult().stream().map(this::toVO).collect(Collectors.toList());

        return new PageResult<>(p.getTotal(),voList);
    }

    @Override
    public List<ProjectAgentVO> listAll(Long projectId, Long userId) {
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
        // 加入项目默认参与
        if (entity.getStatus() == null) {
            entity.setStatus(1);
        }
        projectAgentMapper.insert(entity);
    }

    @Override
    public void update(Long id, ProjectAgentDTO dto) {
        ProjectAgent entity = new ProjectAgent();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        entity.setId(id);
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
        // 格式: "projectId-id1-id2-id3"
        String[] parts = ids.split("-");
        Long projectId = Long.parseLong(parts[0]);
        List<Long> idList = new ArrayList<>();
        for (int i = 1; i < parts.length; i++) {
            idList.add(Long.parseLong(parts[i]));
        }
        projectAgentMapper.deleteByIds(idList, projectId, LocalDateTime.now());
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
        List<AgentPool> pool = agentPoolMapper.selectByIds(dto.getAgentIds());
        LocalDateTime now = LocalDateTime.now();
        int count = 0;
        for (AgentPool p : pool) {
            ProjectAgent entity = new ProjectAgent();
            entity.setProjectId(dto.getProjectId());
            entity.setUserId(dto.getUserId());
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
