package com.hina.crewforge;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.transaction.annotation.EnableTransactionManagement;

/**
 * CrewForge — AI 编程助手后端
 *
 * 9/17：去掉 @EnableCaching —— 全仓没有 @Cacheable/@CacheEvict，
 * 缓存是 ProjectFileServiceImpl 直接用 StringRedisTemplate 手写的（带 Redis 不可达兜底）。
 * 留着它 + spring-boot-starter-cache 会让人误以为"这里有声明式缓存"。
 */
@Slf4j
@SpringBootApplication
@EnableTransactionManagement
@EnableScheduling
public class CrewForgeApplication {

    public static void main(String[] args) {
        SpringApplication.run(CrewForgeApplication.class, args);
        log.info("CrewForge server started!");
    }

}
