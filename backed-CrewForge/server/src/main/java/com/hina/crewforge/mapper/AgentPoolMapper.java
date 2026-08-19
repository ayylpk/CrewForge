package com.hina.crewforge.mapper;

import com.hina.crewforge.pojo.QueryParam.AgentPoolQueryParam;
import com.hina.crewforge.pojo.entity.AgentPool;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface AgentPoolMapper {
    List<AgentPool> list(AgentPoolQueryParam agentQueryParam);

    void insert(AgentPool entity);

    void updateById(AgentPool entity);

    AgentPool getById(Long id);

    /** 批量查询（拉取到项目团队时用，按 ids 精确查） */
    List<AgentPool> selectByIds(@Param("ids") List<Long> ids);

    void deleteByIds(@Param("ids") List<Long> ids, @Param("userId") Long userId,
                     @Param("updateTime") LocalDateTime updateTime);

    /** 查用户池里指定角色的 Agent（项目自动补单例角色时用；角色名即中文 label） */
    AgentPool findByRoleAndUser(@Param("role") String role, @Param("userId") Long userId);
}
