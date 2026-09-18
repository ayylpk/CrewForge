services:
  mysql:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: ${DB_NAME:-{{DB_NAME}}}
      MYSQL_USER: ${DB_USER:-{{DB_USER}}}
      MYSQL_PASSWORD: ${DB_PASSWORD:?DB_PASSWORD is required}
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD:?DB_ROOT_PASSWORD is required}
      TZ: UTC
    ports:
      - "127.0.0.1:${DB_PORT:-{{DB_PORT}}}:3306"
    volumes:
      - mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-u", "root", "-p${DB_ROOT_PASSWORD}"]
      interval: 5s
      timeout: 5s
      retries: 20

volumes:
  mysql-data:
