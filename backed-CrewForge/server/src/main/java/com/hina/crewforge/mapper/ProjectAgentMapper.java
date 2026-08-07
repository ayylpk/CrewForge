package com.hina.crewforge.mapper;

import com.hina.crewforge.pojo.QueryParam.ProjectAgentQueryParam;
import com.hina.crewforge.pojo.entity.ProjectAgent;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface ProjectAgentMapper {
    List<ProjectAgent> list(ProjectAgentQueryParam projectAgentQueryParam);

    /** 按 projectId + userId 双条件查全部（无分页） */
    List<ProjectAgent> listAll(@Param("projectId") Long projectId, @Param("userId") Long userId);

    void insert(ProjectAgent entity);

    void updateById(ProjectAgent entity);

    ProjectAgent getById(Long id);

    void deleteByIds(@Param("ids") List<Long> ids, @Param("projectId") Long projectId,
                     @Param("updateTime") LocalDateTime updateTime);
}
