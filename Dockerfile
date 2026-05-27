FROM node:22-alpine

# Wechaty 需要一些系统工具
RUN apk add --no-cache \
  bash \
  tini \
  ca-certificates \
  tzdata && \
  cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
  echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

# 创建数据目录
RUN mkdir -p /app/data

# tini 处理信号转发
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
