spring:
  application:
    name: ${APP_NAME:{{APP_NAME}}}
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
{{DATABASE_APPLICATION_YAML}}

server:
  port: ${SERVER_PORT:8080}

management:
  endpoints:
    web:
      exposure:
        include: health,info
