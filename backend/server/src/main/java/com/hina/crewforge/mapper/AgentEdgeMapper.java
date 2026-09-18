package com.hina.crewforge.mapper;

import com.hina.crewforge.pojo.entity.AgentEdge;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface AgentEdgeMapper {
    /** 按 agentId 查该 Agent 的全部边 */
    List<AgentEdge> listByAgentId(@Param("agentId") Long agentId);

    void insert(AgentEdge entity);

    void updateById(AgentEdge entity);

    AgentEdge getById(Long id);

    void deleteById(@Param("id") Long id, @Param("updateTime") LocalDateTime updateTime);

    /** 按 agentId 批量删除（AgentPool 删除时级联调用，按 userId 二次校验防越权） */
    void deleteByAgentIds(@Param("agentIds") List<Long> agentIds, @Param("userId") Long userId,
                          @Param("updateTime") LocalDateTime updateTime);
}
