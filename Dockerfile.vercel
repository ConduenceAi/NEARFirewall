# NEARFirewall gateway. Build from the repository root:
#   docker build -f apps/gateway/Dockerfile -t nearfirewall-gateway .
# Run (serve it over HTTPS: your host or a reverse proxy terminates TLS):
#   docker run --rm -p 8787:8787 \
#     -e NEARFIREWALL_ACCOUNT=you.testnet \
#     -e NEARFIREWALL_AGENT_KEY=ed25519:... \
#     -e GATEWAY_TOKEN=$(openssl rand -hex 32) \
#     nearfirewall-gateway
FROM node:24-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app

# Install only what the gateway needs. Every workspace manifest is copied so the lockfile matches.
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY packages/templates/package.json packages/templates/
COPY apps/gateway/package.json apps/gateway/
COPY apps/runner/package.json apps/runner/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @nearfirewall/gateway --include-workspace-root=false \
 && npm cache clean --force

COPY packages/sdk/src packages/sdk/src
COPY packages/mcp/src packages/mcp/src
COPY apps/gateway/src apps/gateway/src

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/gateway/src/main.ts"]
