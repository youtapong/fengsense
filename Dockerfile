# Use official Bun image
FROM oven/bun:1-slim AS base

WORKDIR /app

# Install dependencies into temp directory
# This will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Copy node_modules and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY src ./src
COPY tsconfig.json .
COPY package.json .

# Expose port 3000
EXPOSE 3000

# Set environment
ENV NODE_ENV=production

# Run the app
CMD ["bun", "src/index.ts"]
