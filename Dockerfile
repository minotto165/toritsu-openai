FROM oven/bun:alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY tsconfig.json ./
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
