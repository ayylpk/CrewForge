package com.hina.crewforge.service.impl;

import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.AgentEdgeMapper;
import com.hina.crewforge.mapper.AgentPoolMapper;
import com.hina.crewforge.pojo.dto.AgentEdgeDTO;
import com.hina.crewforge.pojo.entity.AgentEdge;
import com.hina.crewforge.pojo.entity.AgentPool;
import com.hina.crewforge.pojo.vo.AgentEdgeVO;
import com.hina.crewforge.service.AgentEdgeService;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.stream.Collectors;

@Service
public class AgentEdgeServiceImpl implements AgentEdgeService {

    /** 合法的连接方式 */
    private static final List<String> EDGE_TYPES = List.of("direct", "conditional", "parallel");

    @Autowired
    private AgentEdgeMapper agentEdgeMapper;

    @Autowired
    private AgentPoolMapper agentPoolMapper;

    /** 空字符串转 null：type/toNodes 声明字段不存 '' */
    private void normalize(AgentEdge entity) {
        if (entity.getFromNode() != null && entity.getFromNode().trim().isEmpty()) {
            entity.setFromNode(null);
        }
        if (entity.getType() != null && entity.getType().trim().isEmpty()) {
            entity.setType(null);
        }
        if (entity.getToNodes() != null && entity.getToNodes().trim().isEmpty()) {
            entity.setToNodes(null);
        }
    }

    /** 归属校验: 边所属池 Agent 必须属于当前登录用户, 防越权读写他人边 */
    private AgentPool ensurePoolAgentOwned(Long agentId) {
        AgentPool poolAgent = agentPoolMapper.getById(agentId);
        if (poolAgent == null) {
            throw new BaseException("Agent 不存在: " + agentId);
        }
        if (!poolAgent.getUserId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权操作他人的 Agent 边");
        }
        return poolAgent;
    }

    /** 校验边归属: 边的 agentId 必须属于当前登录用户 */
    private void ensureEdgeOwned(AgentEdge edge) {
        ensurePoolAgentOwned(edge.getAgentId());
    }

    /** 必填 + type 合法性校验 */
    private void validate(AgentEdgeDTO dto) {
        if (dto.getFromNode() == null || dto.getFromNode().isBlank()) {
            throw new BaseException("from_node 不能为空");
        }
        if (dto.getToNodes() == null || dto.getToNodes().isBlank()) {
            throw new BaseException("to_nodes 不能为空");
        }
        String type = dto.getType() == null ? "direct" : dto.getType();
        if (!EDGE_TYPES.contains(type)) {
            throw new BaseException("非法连接方式 type: " + type + "（只允许 direct/conditional/parallel）");
        }
    }

    @Override
    public List<AgentEdgeVO> listByAgentId(Long agentId) {
        ensurePoolAgentOwned(agentId);
        List<AgentEdge> list = agentEdgeMapper.listByAgentId(agentId);
        return list.stream().map(this::toVO).collect(Collectors.toList());
    }

    @Override
    public void create(AgentEdgeDTO dto) {
        ensurePoolAgentOwned(dto.getAgentId());
        validate(dto);
        AgentEdge entity = new AgentEdge();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        if (entity.getType() == null) {
            entity.setType("direct");
        }
        LocalDateTime now = LocalDateTime.now();
        entity.setCreateTime(now);
        entity.setUpdateTime(now);
        agentEdgeMapper.insert(entity);
    }

    @Override
    public void update(Long id, AgentEdgeDTO dto) {
        AgentEdge existing = agentEdgeMapper.getById(id);
        if (existing == null) {
            throw new BaseException("边不存在: " + id);
        }
        ensureEdgeOwned(existing);
        validate(dto);
        AgentEdge entity = new AgentEdge();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        entity.setId(id);
        // agentId 不允许改, 覆盖为原值
        entity.setAgentId(existing.getAgentId());
        entity.setUpdateTime(LocalDateTime.now());
        agentEdgeMapper.updateById(entity);
    }

    @Override
    public AgentEdgeVO getById(Long id) {
        AgentEdge entity = agentEdgeMapper.getById(id);
        if (entity == null) {
            throw new BaseException("边不存在: " + id);
        }
        ensureEdgeOwned(entity);
        return toVO(entity);
    }

    @Override
    public void deleteById(Long id) {
        AgentEdge existing = agentEdgeMapper.getById(id);
        if (existing == null) {
            throw new BaseException("边不存在: " + id);
        }
        ensureEdgeOwned(existing);
        agentEdgeMapper.deleteById(id, LocalDateTime.now());
    }

    private AgentEdgeVO toVO(AgentEdge agentEdge) {
        AgentEdgeVO vo = new AgentEdgeVO();
        BeanUtils.copyProperties(agentEdge, vo);
        return vo;
    }
}
