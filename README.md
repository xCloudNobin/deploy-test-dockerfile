# deploy-test-dockerfile

Minimal Nginx static site for testing deployments that build a repository Dockerfile.

## Endpoints

- `/` — HTML home page
- `/health.html` — container health check

## Build and run

```bash
docker build -t deploy-test-dockerfile .
docker run --rm -p 8080:8080 deploy-test-dockerfile
```

The image exposes port `8080` and includes a Docker `HEALTHCHECK`.
