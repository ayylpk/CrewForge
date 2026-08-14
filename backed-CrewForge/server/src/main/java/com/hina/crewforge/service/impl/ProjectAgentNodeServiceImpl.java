package com.hina.crewforge.service.impl;

import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.ProjectAgentMapper;
import com.hina.crewforge.mapper.ProjectAgentNodeMapper;
import com.hina.crewforge.pojo.dto.ProjectAgentNodeDTO;
import com.hina.crewforge.pojo.entity.ProjectAgent;
import com.hina.crewforge.pojo.entity.ProjectAgentNode;
import com.hina.crewforge.pojo.vo.ProjectAgentNodeVO;
import com.hina.crewforge.service.ProjectAgentNodeService;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.stream.Collectors;

@Service
public class ProjectAgentNodeServiceImpl implements ProjectAgentNodeService {

    @Autowired
    private ProjectAgentNodeMapper projectAgentNodeMapper;

    @Autowired
    private ProjectAgentMapper projectAgentMapper;

    /** 空字符串转 null：tools 是 JSON 列不能存 ''；model 空串=跟随全局（存 NULL） */
    private void normalize(ProjectAgentNode entity) {
        if (entity.getTools() != null && entity.getTools().trim().isEmpty()) {
            entity.setTools(null);
        }
        if (entity.getModel() != null && entity.getModel().trim().isEmpty()) {
            entity.setModel(null);
        }
    }

    /**
     * 归属校验: 该项目下该池 Agent 的成员行必须属于当前登录用户
     * 查不到抛异常, 防越权读写他人项目成员节点
     */
    private ProjectAgent ensureMember(Long projectId, Long agentId) {
        ProjectAgent member = projectAgentMapper.getByProjectAndAgent(
                projectId, agentId, BaseContext.getCurrentUserId());
        if (member == null) {
            throw new BaseException("项目成员不存在或无权限");
        }
        return member;
    }

    /** 校验节点归属: 节点的 projectId/agentId 必须属于当前登录用户 */
    private void ensureNodeOwned(ProjectAgentNode node) {
        ensureMember(node.getProjectId(), node.getAgentId());
    }

    @Override
    public List<ProjectAgentNodeVO> listByMember(Long projectId, Long agentId) {
        ensureMember(projectId, agentId);
        List<ProjectAgentNode> list = projectAgentNodeMapper.listByMember(projectId, agentId);
        return list.stream().map(this::toVO).collect(Collectors.toList());
    }

    @Override
    public void create(ProjectAgentNodeDTO dto) {
        // 归属校验（userId 不信任前端, 从 JWT 取）
        ensureMember(dto.getProjectId(), dto.getAgentId());
        ProjectAgentNode entity = new ProjectAgentNode();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        LocalDateTime now = LocalDateTime.now();
        entity.setUserId(BaseContext.getCurrentUserId());
        entity.setCreateTime(now);
        entity.setUpdateTime(now);
        // 不传温度时给默认 0.7
        if (entity.getTemperature() == null) {
            entity.setTemperature(0.7);
        }
        projectAgentNodeMapper.insert(entity);
    }

    @Override
    public void update(Long id, ProjectAgentNodeDTO dto) {
        ProjectAgentNode existing = projectAgentNodeMapper.getById(id);
        if (existing == null) {
            throw new BaseException("节点不存在: " + id);
        }
        ensureNodeOwned(existing);
        ProjectAgentNode entity = new ProjectAgentNode();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        entity.setId(id);
        // projectId/agentId/userId 不允许改, 覆盖为原值
        entity.setProjectId(existing.getProjectId());
        entity.setAgentId(existing.getAgentId());
        entity.setUserId(existing.getUserId());
        entity.setUpdateTime(LocalDateTime.now());
        projectAgentNodeMapper.updateById(entity);
    }

    @Override
    public ProjectAgentNodeVO getById(Long id) {
        ProjectAgentNode entity = projectAgentNodeMapper.getById(id);
        if (entity == null) {
            throw new BaseException("节点不存在: " + id);
        }
        ensureNodeOwned(entity);
        return toVO(entity);
    }

    @Override
    public void deleteById(Long id) {
        ProjectAgentNode existing = projectAgentNodeMapper.getById(id);
        if (existing == null) {
            throw new BaseException("节点不存在: " + id);
        }
        ensureNodeOwned(existing);
        projectAgentNodeMapper.deleteById(id, LocalDateTime.now());
    }

    private ProjectAgentNodeVO toVO(ProjectAgentNode node) {
        ProjectAgentNodeVO vo = new ProjectAgentNodeVO();
        BeanUtils.copyProperties(node, vo);
        return vo;
    }
}
