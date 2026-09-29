# syntax=docker/dockerfile:1

# 依赖层：web 与 verify 共用，保证 lockfile 一致性。
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 验收层：一次性运行 类型检查 + 全部测试 + 生产构建。
FROM deps AS verify
COPY . .
CMD ["npm", "run", "verify"]

# 构建层：产出静态页面。
FROM deps AS build
COPY . .
RUN npm run build

# 发布层：nginx 托管静态产物。
FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
