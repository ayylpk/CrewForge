package com.hina.crewforge.service;

import com.hina.crewforge.pojo.dto.AgentEdgeDTO;
import com.hina.crewforge.pojo.vo.AgentEdgeVO;

import java.util.List;

public interface AgentEdgeService {

    /** 按 agentId 查该 Agent 的全部边 */
    List<AgentEdgeVO> listByAgentId(Long agentId);

    void create(AgentEdgeDTO dto);

    void update(Long id, AgentEdgeDTO dto);

    AgentEdgeVO getById(Long id);

    void deleteById(Long id);
}
