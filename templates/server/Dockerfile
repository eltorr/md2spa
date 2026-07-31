# md2spa -> a self-hosted static site
#
# Written by `md2spa template server`. Build and run:
#
#   docker build -t my-docs .
#   docker run --rm -p 8080:80 my-docs
#
# or `docker compose up --build` to use the bundled compose file.
#
# Two stages: node builds the site, nginx serves it. The runtime image contains only
# static files and nginx -- no Node.js, no source, no package manager, nothing with a CVE
# feed to keep up with. It comes out around 50 MB.

# ---------------------------------------------------------------------------------------
# Stage 1 -- build
# ---------------------------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# md2spa has zero runtime dependencies, so the whole repository is copied in one layer
# and there is no `npm install` step to cache or to fail offline.
COPY . .

# `--strict` promotes warnings to errors: a broken relative link, a table missing its
# delimiter row or an image without alt text fails the image build instead of shipping.
# Drop it if you would rather warnings did not block a deploy.
RUN node src/cli.js build --out /site --strict

# ---------------------------------------------------------------------------------------
# Stage 2 -- serve
# ---------------------------------------------------------------------------------------
FROM nginx:alpine AS serve

# Replace the stock config rather than adding to it, so there is exactly one server block.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site /usr/share/nginx/html

# nginx:alpine already runs as root in the master process and drops to `nginx` for
# workers, which is what the stock config expects. Nothing here needs write access.
EXPOSE 80

# Fail the container's health check if nginx stops answering, so an orchestrator can
# restart it rather than leaving a dead endpoint in the load balancer.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
