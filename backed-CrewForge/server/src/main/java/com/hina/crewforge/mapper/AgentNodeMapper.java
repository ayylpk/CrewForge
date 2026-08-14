package com.hina.crewforge.mapper;

import com.hina.crewforge.pojo.entity.AgentNode;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface AgentNodeMapper {
    /** 按 agentId 查该 Agent 的全部节点 */
    List<AgentNode> listByAgentId(@Param("agentId") Long agentId);

    /** 按 ids 批量查节点（拉取成员复制节点时用） */
    List<AgentNode> selectByAgentIds(@Param("agentIds") List<Long> agentIds);

    void insert(AgentNode entity);

    void updateById(AgentNode entity);

    AgentNode getById(Long id);

    void deleteById(@Param("id") Long id, @Param("updateTime") LocalDateTime updateTime);

    /** 按 agentId 批量删除（AgentPool 删除时级联调用，按 userId 二次校验防越权） */
    void deleteByAgentIds(@Param("agentIds") List<Long> agentIds, @Param("userId") Long userId,
                          @Param("updateTime") LocalDateTime updateTime);
}
