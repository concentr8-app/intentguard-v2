# Public download repo (one-time setup)

The code stays in the private `intentguard-v2`. A second, public repo `concentr8-app/concentr8` holds only the finished app.
It contains no source code and no secrets, so nothing sensitive can leak. Only clean versions (`v1.0.0`) are published, no betas.

1. GitHub → concentr8-app → New repository → name `concentr8`, **Public**, add a README ("Download Concentr8 for Mac: see Releases").
2. Create a token that may only write to that repo: Settings (your profile) → Developer settings → Fine-grained tokens → Repository access: only `concentr8` → Permissions: Contents = Read and write.
3. In the private repo: Settings → Secrets and variables → Actions → New secret `RELEASE_TOKEN` = that token.
4. Release: `git tag v1.0.0` then `git push origin v1.0.0`. The Action builds and publishes. The download page at the call server picks it up (`/releases/latest/download/Concentr8-arm64.dmg`).
