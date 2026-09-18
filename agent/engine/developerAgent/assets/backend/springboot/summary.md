---
id: springboot
kind: backend
version: 3.5.5
runtime: Java 17+
provides: [http.rest, validation.bean, persistence.jpa, health.http]
requires: [database.relational]
recommendedFor: [CRUD, management-system, transactional-business]
avoidWhen: [tiny-edge-function, no-jvm-runtime]
build: ./mvnw package
boot: java -jar target/*.jar
details: manifest.json
---
成熟的分层 REST 后端资产，适合需要事务、校验和关系数据持久化的项目。
