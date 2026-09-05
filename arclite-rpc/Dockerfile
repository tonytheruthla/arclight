FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
ENV PORT=8080
EXPOSE 8080
# No dependencies to install — stdlib only, by design.
# Use $PORT, not a hardcoded 8080: hosts like Railway inject their own port at
# runtime, and a healthcheck pinned to 8080 would report the container unhealthy
# even while it serves traffic correctly on the injected port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/health" || exit 1
CMD ["node","server.js"]
