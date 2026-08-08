package com.hina.crewforge.service;

import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.pojo.QueryParam.ProjectAgentQueryParam;
import com.hina.crewforge.pojo.dto.ProjectAgentCopyDTO;
import com.hina.crewforge.pojo.dto.ProjectAgentDTO;
import com.hina.crewforge.pojo.vo.ProjectAgentVO;
import java.util.List;


public interface ProjectAgentService {

    PageResult<ProjectAgentVO> page(ProjectAgentQueryParam projectAgentQueryParam);

    /** 查询某项目某用户的全部 Agent（无分页，团队配置页回显用） */
    List<ProjectAgentVO> listAll(Long projectId, Long userId);

    void create(ProjectAgentDTO dto);

    void update(Long id, ProjectAgentDTO dto);

    ProjectAgentVO getById(Long id);

    void deleteByIds(String ids);

    /** 从 Agent 池复制到项目团队（复制非引用，批量，一个事务） */
    int copyFromPool(ProjectAgentCopyDTO dto);
}
