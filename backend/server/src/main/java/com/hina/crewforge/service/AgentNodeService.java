package com.hina.crewforge.service;

import com.hina.crewforge.pojo.dto.AgentNodeDTO;
import com.hina.crewforge.pojo.vo.AgentNodeVO;

import java.util.List;

public interface AgentNodeService {

    /** 按 agentId 查该 Agent 的全部节点 */
    List<AgentNodeVO> listByAgentId(Long agentId);

    void create(AgentNodeDTO dto);

    void update(Long id, AgentNodeDTO dto);

    AgentNodeVO getById(Long id);

    void deleteById(Long id);
}
