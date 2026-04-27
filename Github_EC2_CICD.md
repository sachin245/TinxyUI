# GitHub → EC2 CI/CD Setup

Automatically deploys TinxyUI to AWS EC2 on every push to `main`.

## Stack

| Layer | Tool |
|-------|------|
| Process manager | PM2 |
| Web server / SSL | nginx + Let's Encrypt |
| App server | Node.js (`tinxy-ui/serve.js`) on port 3456 |
| EC2 OS | Amazon Linux 2023 |
| EC2 user | `ec2-user` |
| Repo path on EC2 | `/home/ec2-user/TinxyUI` |

---

## Steps Followed

### 1. Created the GitHub Actions workflow

File: `.github/workflows/deploy.yml`

```yaml
name: Deploy to EC2

on:
  push:
    branches: [main]

jobs:
  deploy:
    name: SSH deploy to EC2
    runs-on: ubuntu-latest

    steps:
      - name: Setup SSH key
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.EC2_SSH_KEY }}" > ~/.ssh/ec2.pem
          chmod 600 ~/.ssh/ec2.pem
          ssh-keyscan -H "${{ secrets.EC2_HOST }}" >> ~/.ssh/known_hosts 2>/dev/null

      - name: Pull latest code and restart app
        run: |
          ssh -i ~/.ssh/ec2.pem ec2-user@${{ secrets.EC2_HOST }} << 'EOF'
            set -e
            cd /home/ec2-user/TinxyUI
            git pull origin main
            pm2 restart tinxy-ui
          EOF
```

**How it works:**
- Triggers on every push to `main`
- GitHub runner writes the EC2 private key to a temp file
- `ssh-keyscan` fetches the EC2 host key to avoid interactive fingerprint prompts
- SSHs into EC2, pulls latest code, restarts the PM2 process

---

### 2. Added GitHub Secrets

Secrets are stored in the repo under **Settings → Secrets and variables → Actions**.

| Secret name | Value |
|-------------|-------|
| `EC2_HOST` | `54.91.145.63` (EC2 public IP) |
| `EC2_SSH_KEY` | Full contents of `ec2-access.pem` |

Set via CLI:
```bash
gh secret set EC2_HOST --body "54.91.145.63" --repo sachin245/TinxyUI
gh secret set EC2_SSH_KEY < ec2-access.pem --repo sachin245/TinxyUI
```

---

### 3. Committed and pushed the workflow

```bash
git add .github/workflows/deploy.yml
git commit -m "Add GitHub Actions CI/CD workflow to auto-deploy to EC2"
git push origin main
```

This push itself triggered the first run of the workflow.

---

### 4. Verified the run

```bash
gh run list --repo sachin245/TinxyUI --workflow deploy.yml --limit 1
```

Output confirmed: **completed — success** in 11 seconds.

Full log showed:
- `git pull` fast-forwarded EC2 repo to latest commit
- `pm2 restart tinxy-ui` restarted successfully → status **online**

---

## How to Update EC2 IP (if it changes)

```bash
gh secret set EC2_HOST --body "<new-ip>" --repo sachin245/TinxyUI
```

No workflow changes needed.

---

## Triggering a Manual Redeploy

Push any commit to `main`, or trigger manually from GitHub:

```bash
gh workflow run deploy.yml --repo sachin245/TinxyUI
```

---

## Checking Deploy Status

```bash
# Latest run
gh run list --repo sachin245/TinxyUI --workflow deploy.yml --limit 5

# Full logs of a specific run
gh run view <run-id> --repo sachin245/TinxyUI --log
```
