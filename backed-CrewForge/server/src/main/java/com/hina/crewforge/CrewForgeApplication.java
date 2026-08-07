package com.hina.crewforge;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.transaction.annotation.EnableTransactionManagement;

/**
 * CrewForge — AI 编程助手后端
 */
@Slf4j
@SpringBootApplication
@EnableTransactionManagement
@EnableCaching
@EnableScheduling
public class CrewForgeApplication {

    public static void main(String[] args) {
        SpringApplication.run(CrewForgeApplication.class, args);
        log.info("CrewForge server started!");
    }

}
