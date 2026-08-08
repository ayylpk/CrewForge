package com.hina.crewforge.service.impl;

import com.github.pagehelper.Page;
import com.github.pagehelper.PageHelper;
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
        // 新增默认启用
        if (entity.getStatus() == null) {
            entity.setStatus(1);
        }
        agentMapper.insert(entity);
    }

    @Override
    public void update(Long id, AgentPoolDTO dto) {
        AgentPool entity = new AgentPool();
        BeanUtils.copyProperties(dto, entity);
        normalize(entity);
        entity.setId(id);
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
        // 格式: "userId-id1-id2-id3"
        String[] parts = ids.split("-");
        Long userId = Long.parseLong(parts[0]);
        List<Long> idList = new ArrayList<>();
        for (int i = 1; i < parts.length; i++) {
            idList.add(Long.parseLong(parts[i]));
        }
        agentMapper.deleteByIds(idList, userId, LocalDateTime.now());
    }

    private AgentPoolVO toVO(AgentPool agent) {
        AgentPoolVO vo = new AgentPoolVO();
        BeanUtils.copyProperties(agent,vo);
        return vo;
    }
}
