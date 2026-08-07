package com.hina.crewforge.service;

import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.pojo.QueryParam.AgentPoolQueryParam;
import com.hina.crewforge.pojo.dto.AgentPoolDTO;
import com.hina.crewforge.pojo.vo.AgentPoolVO;


public interface AgentPoolService {

    PageResult<AgentPoolVO> page(AgentPoolQueryParam agentQueryParam);

    void create(AgentPoolDTO dto);

    void update(Long id, AgentPoolDTO dto);

    AgentPoolVO getById(Long id);

    void deleteByIds(String ids);
}
