# ------------ Build & Runtime (node:20 + pnpm) ------------
FROM node:20-alpine

# Enable pnpm via corepack (built-in on Node 20)
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Copy manifests first for better layer cache
COPY package.json ./
# (opsional) jika punya pnpm-lock.yaml, copy juga untuk reproducible install
# COPY pnpm-lock.yaml ./

# Install only production deps by default (ubah kalau butuh dev deps)
RUN pnpm install --prod

# Copy source
COPY src ./src
COPY views ./views

ENV SMTP_PORT=587
ENV SMTP_SECURE=false       
ENV SMTP_USER=no-reply@hiatlaz.com
ENV SMTP_PASS=fmxufdwhlechkdqq
ENV SMTP_USER_MARKETING=atlaz.marketing1@gmail.com
ENV SMTP_PASS_MARKETING=gheejehwnpydmpof
ENV SMTP_USER_PARTNERSHIP=partnership@hiatlaz.com
ENV SMTP_PASS_PARTNERSHIP=pftemeqdflahloje


ENV FROM_NAME=Hiatlaz
ENV FROM_EMAIL=no-reply@hiatlaz.com

ENV PORT=3101

EXPOSE 3101
CMD ["pnpm", "start"]
