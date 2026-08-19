package com.hina.crewforge.service.impl;

import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.AgentNodeMapper;
import com.hina.crewforge.mapper.AgentPoolMapper;
import com.hina.crewforge.pojo.dto.AgentNodeDTO;
import com.hina.crewforge.pojo.entity.AgentNode;
import com.hina.crewforge.pojo.entity.AgentPool;
import com.hina.crewforge.pojo.vo.AgentNodeVO;
import com.hina.crewforge.service.AgentNodeService;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.stream.Collectors;

@Service
public class AgentNodeServiceImpl implements AgentNodeService {

    @Autowired
    private AgentNodeMapper agentNodeMapper;

    @Autowired
    private AgentPoolMapper agentPoolMapper;

    /** 空字符串转 null：tools 是 JSON 列不能存 ''；model 空串=跟随全局（存 NULL）；可选声明字段同理 */
    private void normalize(AgentNode entity) {
        if (entity.getTools() != null && entity.getTools().trim().isEmpty()) {
            entity.setTools(null);
        }
        if (entity.getModel() != null && entity.getModel().trim().isEmpty()) {
            entity.setModel(null);
        }
        if (entity.getNodeType() != null && entity.getNodeType().trim().isEmpty()) {
            entity.setNodeType(null);
        }
        if (entity.getSchemaKey() != null && entity.getSchemaKey().trim().isEmpty()) {
            entity.setSchemaKey(null);
        }
        if (entity.getCodeKey() != null && entity.getCodeKey().trim().isEmpty()) {
            entity.setCodeKey(null);
        }
        if (entity.getOutput() != null && entity.getOutput().trim().isEmpty()) {
            entity.setOutput(null);
        }
    }

    /** 归属校验: 节点所属池 Agent 必须属于当前登录用户, 防越权读写他人节点 */
    private AgentPool ensurePoolAgentOwned(Long agentId) {
        AgentPool poolAgent = agentPoolMapper.getById(agentId);
        if (poolAgent == null) {
            throw new BaseException("Agent 不存在: " + agentId);
        }
        if (!poolAgent.getUserId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权操作他人的 Agent 节点");
        }
        return poolAgent;
    }

    /** 校验节点归属: 节点的 agentId 必须属于当前登录用户 */
    private void ensureNodeOwned(AgentNode node) {
        ensurePoolAgentOwned(node.getAgentId());
    }

    @Override
    public List<AgentNodeVO> listByAgentId(Long agentId) {
        ensurePoolAgentOwned(agentId);
        List<AgentNode> list = agentNodeMapper.listByAgentId(agentId);
        return list.stream().map(this::toVO).collect(Collectors.toList());
    }

    @Override
    public void create(AgentNodeDTO dto) {
        ensurePoolAgentOwned(dto.getAgentId());
        AgentNode entity = new AgentNode();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        LocalDateTime now = LocalDateTime.now();
        entity.setCreateTime(now);
        entity.setUpdateTime(now);
        // 不传温度时给默认 0.7；不传节点类型时给默认 llm（老数据/前端未传）
        if (entity.getTemperature() == null) {
            entity.setTemperature(0.7);
        }
        if (entity.getNodeType() == null) {
            entity.setNodeType("llm");
        }
        agentNodeMapper.insert(entity);
    }

    @Override
    public void update(Long id, AgentNodeDTO dto) {
        AgentNode existing = agentNodeMapper.getById(id);
        if (existing == null) {
            throw new BaseException("节点不存在: " + id);
        }
        ensureNodeOwned(existing);
        AgentNode entity = new AgentNode();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        entity.setId(id);
        // agentId 不允许改, 覆盖为原值
        entity.setAgentId(existing.getAgentId());
        entity.setUpdateTime(LocalDateTime.now());
        agentNodeMapper.updateById(entity);
    }

    @Override
    public AgentNodeVO getById(Long id) {
        AgentNode entity = agentNodeMapper.getById(id);
        if (entity == null) {
            throw new BaseException("节点不存在: " + id);
        }
        ensureNodeOwned(entity);
        return toVO(entity);
    }

    @Override
    public void deleteById(Long id) {
        AgentNode existing = agentNodeMapper.getById(id);
        if (existing == null) {
            throw new BaseException("节点不存在: " + id);
        }
        ensureNodeOwned(existing);
        agentNodeMapper.deleteById(id, LocalDateTime.now());
    }

    private AgentNodeVO toVO(AgentNode agentNode) {
        AgentNodeVO vo = new AgentNodeVO();
        BeanUtils.copyProperties(agentNode, vo);
        return vo;
    }
}
