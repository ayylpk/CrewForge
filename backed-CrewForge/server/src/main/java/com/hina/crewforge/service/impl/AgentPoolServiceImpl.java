package com.hina.crewforge.service.impl;

import com.github.pagehelper.Page;
import com.github.pagehelper.PageHelper;
import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.mapper.AgentPoolMapper;
import com.hina.crewforge.pojo.QueryParam.AgentPoolQueryParam;
import com.hina.crewforge.pojo.dto.AgentPoolDTO;
import com.hina.crewforge.pojo.entity.AgentPool;
import com.hina.crewforge.pojo.vo.AgentPoolVO;
import com.hina.crewforge.service.AgentPoolService;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

@Service
public class AgentPoolServiceImpl implements AgentPoolService {

    @Autowired
    private AgentPoolMapper agentMapper;

    @Override
    public PageResult<AgentPoolVO> page(AgentPoolQueryParam agentQueryParam) {
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        agentQueryParam.setUserId(BaseContext.getCurrentUserId());
        PageHelper.startPage(agentQueryParam.getPage(),agentQueryParam.getPageSize());

        List<AgentPool> list = agentMapper.list(agentQueryParam);
        Page<AgentPool> p = (Page<AgentPool>)list;

        List<AgentPoolVO> voList = p.getResult().stream().map(this::toVO).collect(Collectors.toList());

        return new PageResult<>(p.getTotal(),voList);
    }

    /** 空字符串转 null：tools 是 JSON 列不能存 ''；model 空串=跟随全局（存 NULL） */
    private void normalize(AgentPool entity) {
        if (entity.getTools() != null && entity.getTools().trim().isEmpty()) {
            entity.setTools(null);
        }
        if (entity.getModel() != null && entity.getModel().trim().isEmpty()) {
            entity.setModel(null);
        }
    }

    @Override
    public void create(AgentPoolDTO dto) {
        AgentPool entity = new AgentPool();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        LocalDateTime now = LocalDateTime.now();
        entity.setCreateTime(now);
        entity.setUpdateTime(now);
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        entity.setUserId(BaseContext.getCurrentUserId());
        // 新增默认启用
        if (entity.getStatus() == null) {
            entity.setStatus(1);
        }
        agentMapper.insert(entity);
    }

    @Override
    public void update(Long id, AgentPoolDTO dto) {
        // 1. 存在 + 所有权校验（池按用户隔离，只能改自己的）
        AgentPool existing = agentMapper.getById(id);
        if (existing == null) {
            throw new BaseException("Agent 不存在: " + id);
        }
        if (!existing.getUserId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权修改他人的 Agent");
        }
        // 2. 更新（userId 不允许改, 从实体里去不掉则覆盖为原值）
        AgentPool entity = new AgentPool();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        entity.setId(id);
        entity.setUserId(existing.getUserId());
        entity.setUpdateTime(LocalDateTime.now());
        agentMapper.updateById(entity);
    }

    @Override
    public AgentPoolVO getById(Long id) {
        AgentPool entity = agentMapper.getById(id);
        return toVO(entity);
    }

    @Override
    public void deleteByIds(String ids) {
        // 格式: "id1-id2-id3"（userId 不拼在路径里了, 从 JWT 取当前登录用户）
        String[] parts = ids.split("-");
        Long userId = BaseContext.getCurrentUserId();
        List<Long> idList = new ArrayList<>();
        for (String part : parts) {
            idList.add(Long.parseLong(part));
        }
        agentMapper.deleteByIds(idList, userId, LocalDateTime.now());
    }

    private AgentPoolVO toVO(AgentPool agent) {
        AgentPoolVO vo = new AgentPoolVO();
        BeanUtils.copyProperties(agent,vo);
        return vo;
    }
}
