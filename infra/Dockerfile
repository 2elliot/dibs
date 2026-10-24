# Single image for the Azure Container App: the analysis worker + the dashboard static files.
# Build from the REPO ROOT so the whole npm workspace is in context:
#   DOCKER_BUILDKIT=1 docker build -f infra/Dockerfile --platform linux/amd64 -t dibs:local .
# (BuildKit also reads infra/Dockerfile.dockerignore.)
FROM node:24-slim AS build
WORKDIR /app
ENV NODE_ENV=development
# Workspaces export TypeScript source run via tsx, so there is no compile step for the worker;
# we install all deps (tsx included) and build only the dashboard if it is present.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY spacetime/package.json ./spacetime/package.json
RUN npm ci
RUN if [ -f apps/dashboard/package.json ]; then npm run build -w @dibs/dashboard; fi

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Read PORT at runtime (Container Apps may inject its own); default 8080.
COPY --from=build /app /app
EXPOSE 8080
# tsx is resolved from the installed devDependencies copied above.
CMD ["npm", "run", "start", "-w", "@dibs/worker"]
