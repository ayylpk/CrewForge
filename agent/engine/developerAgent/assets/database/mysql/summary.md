---
id: mysql
kind: database
version: 8.4
runtime: MySQL Server 8.4
provides: [database.relational, database.sql, database.transactions, jdbc.mysql]
requires: []
recommendedFor: [transactional-data, relational-model, CRUD]
avoidWhen: [embedded-only, document-first-model]
migration: Flyway SQL
health: mysqladmin ping
details: manifest.json
---
MySQL 8.4 关系数据库资产，提供容器化开发环境、迁移基线和后端集成片段。
