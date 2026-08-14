package com.hina.crewforge.mapper;

import com.hina.crewforge.pojo.entity.ProjectAgentNode;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface ProjectAgentNodeMapper {
    /** 按项目 + 池 Agent 查该成员的全部节点 */
    List<ProjectAgentNode> listByMember(@Param("projectId") Long projectId, @Param("agentId") Long agentId);

    void insert(ProjectAgentNode entity);

    void updateById(ProjectAgentNode entity);

    ProjectAgentNode getById(Long id);

    void deleteById(@Param("id") Long id, @Param("updateTime") LocalDateTime updateTime);

    /** 按成员 id 批量删除（项目成员删除时级联，子查询限定 projectId+userId 防越权） */
    void deleteByMemberIds(@Param("projectId") Long projectId, @Param("memberIds") List<Long> memberIds,
                           @Param("userId") Long userId, @Param("updateTime") LocalDateTime updateTime);
}
