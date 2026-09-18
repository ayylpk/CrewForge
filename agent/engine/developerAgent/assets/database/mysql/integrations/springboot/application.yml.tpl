  datasource:
    url: jdbc:mysql://${DB_HOST:127.0.0.1}:${DB_PORT:3306}/${DB_NAME:{{DB_NAME}}?useUnicode=true&characterEncoding=utf8&serverTimezone=UTC
    username: ${DB_USER:{{DB_USER}}}
    password: ${DB_PASSWORD:}
  flyway:
    enabled: true
    locations: classpath:db/migration
    validate-on-migrate: true
