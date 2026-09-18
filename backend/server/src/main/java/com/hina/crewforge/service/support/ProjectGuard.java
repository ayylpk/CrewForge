package com.hina.crewforge.service.support;

import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.ProjectMapper;
import com.hina.crewforge.pojo.entity.Project;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 项目所有权门卫（施工卡 1-1 要求的"公共方法，阶段 2 B3 复用同一把"）
 *
 * 用法：任何按 projectId 操作、且 projectId 来自外部输入的接口，
 * 先 requireOwned(projectId) 拿到 Project——不存在/非属主直接抛，一行完成两检。
 * （阶段 2 会把 ProjectRun 的 start/stop/status 与 ProjectServiceImpl 私有校验统一到这里。）
 */
@Component
@RequiredArgsConstructor
public class ProjectGuard {

    private final ProjectMapper projectMapper;

    /** 项目必须存在且属于当前登录用户；返回实体供调用方继续用（少查一次库） */
    public Project requireOwned(Long projectId) {
        if (projectId == null) {
            throw new BaseException("projectId 不能为空");
        }
        Project project = projectMapper.selectById(projectId);
        if (project == null) {
            throw new BaseException("项目不存在: " + projectId);
        }
        if (!project.getCreateUser().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权操作他人项目");
        }
        return project;
    }
}
