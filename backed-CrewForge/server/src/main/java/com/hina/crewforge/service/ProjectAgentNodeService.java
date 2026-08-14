package com.hina.crewforge.service;

import com.hina.crewforge.pojo.dto.ProjectAgentNodeDTO;
import com.hina.crewforge.pojo.vo.ProjectAgentNodeVO;

import java.util.List;

public interface ProjectAgentNodeService {

    /** 按项目 + 池 Agent 查该成员的全部节点 */
    List<ProjectAgentNodeVO> listByMember(Long projectId, Long agentId);

    void create(ProjectAgentNodeDTO dto);

    void update(Long id, ProjectAgentNodeDTO dto);

    ProjectAgentNodeVO getById(Long id);

    void deleteById(Long id);
}
