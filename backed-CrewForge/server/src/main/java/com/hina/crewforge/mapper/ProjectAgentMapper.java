package com.hina.crewforge.mapper;

import com.hina.crewforge.pojo.QueryParam.ProjectAgentQueryParam;
import com.hina.crewforge.pojo.entity.ProjectAgent;
import com.hina.crewforge.pojo.vo.ProjectAgentVO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface ProjectAgentMapper {
    List<ProjectAgent> list(ProjectAgentQueryParam projectAgentQueryParam);

    /** 按 projectId + userId 双条件查全部（无分页，JOIN sys_agent 带 name/role） */
    List<ProjectAgentVO> listAll(@Param("projectId") Long projectId, @Param("userId") Long userId);

    void insert(ProjectAgent entity);

    void updateById(ProjectAgent entity);

    /** 查询单个（JOIN sys_agent 带 name/role） */
    ProjectAgentVO getById(Long id);

    /** 按 projectId + agentId + userId 查成员行（归属校验用, 查不到即无权限） */
    ProjectAgent getByProjectAndAgent(@Param("projectId") Long projectId, @Param("agentId") Long agentId,
                                      @Param("userId") Long userId);

    void deleteByIds(@Param("ids") List<Long> ids, @Param("projectId") Long projectId,
                     @Param("userId") Long userId, @Param("updateTime") LocalDateTime updateTime);
}
