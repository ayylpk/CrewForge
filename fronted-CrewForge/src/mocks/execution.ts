
/**
 * 开发期 mock — 执行面板模拟数据
 * 模拟 Agent 团队按阶段生成文件的完整时间线
 */

/** 每个生成文件的代码内容（真实感片段） */
export const MOCK_FILES: Record<string, string> = {
  'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.5.15</version>
    </parent>
    <groupId>com.crewforge</groupId>
    <artifactId>demo-project</artifactId>
    <version>1.0-SNAPSHOT</version>
    <properties>
        <java.version>17</java.version>
    </properties>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>com.baomidou</groupId>
            <artifactId>mybatis-plus-spring-boot3-starter</artifactId>
            <version>3.5.9</version>
        </dependency>
    </dependencies>
</project>
`,

  'application.yml': `server:
  port: 8080

spring:
  datasource:
    driver-class-name: com.mysql.cj.jdbc.Driver
    url: jdbc:mysql://localhost:3306/demo?serverTimezone=Asia/Shanghai
    username: root
    password: 123456
  data:
    redis:
      host: localhost
      port: 6379

mybatis-plus:
  mapper-locations: classpath:mapper/*.xml
  configuration:
    map-underscore-to-camel-case: true
`,

  'User.java': `package com.crewforge.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("sys_user")
public class User {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String username;
    private String password;
    private Integer role;
    private Integer status;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableLogic
    private Integer deleted;
}
`,

  'UserController.java': `package com.crewforge.controller;

import com.crewforge.common.result.Result;
import com.crewforge.entity.User;
import com.crewforge.service.UserService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/users")
@RequiredArgsConstructor
public class UserController {

    private final UserService userService;

    @GetMapping
    public Result<List<User>> list() {
        return Result.success(userService.list());
    }

    @PostMapping
    public Result<Void> create(@RequestBody User user) {
        userService.save(user);
        return Result.success();
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        userService.removeById(id);
        return Result.success();
    }
}
`,

  'UserService.java': `package com.crewforge.service;

import com.baomidou.mybatisplus.extension.service.IService;
import com.crewforge.entity.User;

public interface UserService extends IService<User> {
}
`,

  'UserMapper.java': `package com.crewforge.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.crewforge.entity.User;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface UserMapper extends BaseMapper<User> {
}
`,

  'UserList.vue': `<template>
  <div class="user-list">
    <el-card>
      <template #header>
        <div class="card-head">
          <span>用户管理</span>
          <el-button type="primary" @click="createVisible = true">新增用户</el-button>
        </div>
      </template>

      <el-table :data="users" stripe>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="username" label="用户名" />
        <el-table-column prop="role" label="角色" />
        <el-table-column prop="createTime" label="创建时间" />
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { fetchUsers, deleteUser } from '../api/user'

const users = ref<any[]>([])

onMounted(async () => {
  users.value = await fetchUsers()
})

function remove(row: any) {
  deleteUser(row.id).then(() => {
    ElMessage.success('删除成功')
    users.value = users.value.filter((u) => u.id !== row.id)
  })
}
</script>
`,

  'user.ts': `import request from '../utils/request'

export interface User {
  id: number
  username: string
  role: number
  createTime: string
}

export function fetchUsers() {
  return request.get<User[]>('/api/users')
}

export function createUser(data: Partial<User>) {
  return request.post('/api/users', data)
}

export function deleteUser(id: number) {
  return request.delete(\`/api/users/\${id}\`)
}
`,

  'router/index.ts': `import { createRouter, createWebHistory } from 'vue-router'
import UserList from '../views/UserList.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/users' },
    { path: '/users', component: UserList },
  ],
})

export default router
`,

  'README.md': `# Demo Project

由 CrewForge AI 编程助手生成

## 技术栈
- 后端：Spring Boot 3.5 + MyBatis-Plus + MySQL
- 前端：Vue 3 + Element Plus + TypeScript

## 快速开始
1. 导入数据库脚本 db/init.sql
2. 修改 application.yml 数据库连接
3. 后端：mvn spring-boot:run
4. 前端：npm install && npm run dev
`,
}

/** 执行时间线：每个事件模拟 Agent 的一次动作 */
export interface ExecEvent {
  at: number // 距开始毫秒
  agentId: number // 对应成员 id
  status: 'working' | 'done'
  task?: string // 当前任务描述
  phase?: string // 阶段名
  phaseProgress?: number // 阶段进度 0-100
  file?: { path: string; content: string }
  log: string // 执行日志
}

export const EXEC_TIMELINE: ExecEvent[] = [
  { at: 0, agentId: 2, status: 'working', task: '生成项目骨架', phase: '阶段 1 · 基础架构搭建', phaseProgress: 10, log: '架构师开始规划项目结构' },
  { at: 1200, agentId: 2, status: 'working', task: '设计数据库表结构', log: '分析功能清单，设计 sys_user 表' },
  { at: 2400, agentId: 2, status: 'done', task: '生成骨架文件', phaseProgress: 45, file: { path: 'backend/pom.xml', content: MOCK_FILES['pom.xml'] }, log: '生成 pom.xml' },
  { at: 3600, agentId: 2, status: 'done', file: { path: 'backend/src/main/resources/application.yml', content: MOCK_FILES['application.yml'] }, log: '生成 application.yml' },
  { at: 4800, agentId: 2, status: 'done', task: '完成基础架构', phaseProgress: 100, file: { path: 'README.md', content: MOCK_FILES['README.md'] }, log: '基础架构完成，进入后端开发' },

  { at: 6000, agentId: 3, status: 'working', task: '生成用户管理模块', phase: '阶段 2 · 核心功能开发', phaseProgress: 5, log: '后端 Agent 开始编写用户模块' },
  { at: 7200, agentId: 3, status: 'done', file: { path: 'backend/src/main/java/com/crewforge/entity/User.java', content: MOCK_FILES['User.java'] }, log: '生成 User 实体' },
  { at: 8400, agentId: 3, status: 'done', file: { path: 'backend/src/main/java/com/crewforge/mapper/UserMapper.java', content: MOCK_FILES['UserMapper.java'] }, log: '生成 UserMapper' },
  { at: 9600, agentId: 3, status: 'done', file: { path: 'backend/src/main/java/com/crewforge/service/UserService.java', content: MOCK_FILES['UserService.java'] }, log: '生成 UserService' },
  { at: 10800, agentId: 3, status: 'done', task: '用户模块完成', phaseProgress: 45, file: { path: 'backend/src/main/java/com/crewforge/controller/UserController.java', content: MOCK_FILES['UserController.java'] }, log: '生成 UserController，后端模块完成' },

  { at: 12000, agentId: 4, status: 'working', task: '生成用户管理页面', phaseProgress: 50, log: '前端 Agent 开始编写页面' },
  { at: 13200, agentId: 4, status: 'done', file: { path: 'frontend/src/api/user.ts', content: MOCK_FILES['user.ts'] }, log: '生成 api/user.ts' },
  { at: 14400, agentId: 4, status: 'done', file: { path: 'frontend/src/router/index.ts', content: MOCK_FILES['router/index.ts'] }, log: '生成路由配置' },
  { at: 15600, agentId: 4, status: 'done', task: '前端页面完成', phaseProgress: 90, file: { path: 'frontend/src/views/UserList.vue', content: MOCK_FILES['UserList.vue'] }, log: '生成 UserList.vue，前端完成' },

  { at: 16800, agentId: 5, status: 'working', task: '检查接口一致性', phase: '阶段 3 · 集成与测试', phaseProgress: 15, log: '测试 Agent 开始审查代码' },
  { at: 18000, agentId: 5, status: 'done', task: '发现 0 个问题', phaseProgress: 100, log: '接口一致性检查通过' },

  { at: 19200, agentId: 1, status: 'working', task: '汇总交付', phase: '阶段 4 · 部署交付', phaseProgress: 40, log: 'AI 经理汇总所有产出' },
  { at: 20400, agentId: 1, status: 'done', task: '全部完成', phaseProgress: 100, log: '项目交付完成，共生成 9 个文件' },
]

/** Agent 状态展示名（对应团队页成员顺序） */
export const AGENT_NAMES: Record<number, { name: string; avatar: string }> = {
  1: { name: 'AI 经理', avatar: 'agent-manager.png' },
  2: { name: '架构师', avatar: 'agent-architect.png' },
  3: { name: '后端 Agent', avatar: 'agent-backend.png' },
  4: { name: '前端 Agent', avatar: 'agent-frontend.png' },
  5: { name: '测试 Agent', avatar: 'agent-tester.png' },
  6: { name: '维护 Agent', avatar: 'agent-maintainer.png' },
}
