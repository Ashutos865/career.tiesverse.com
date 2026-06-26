# Deploying the Career API to EC2 (`api.career.tiesverse.com`)

Architecture:

```
career.tiesverse.com       → static HTML/JS/CSS on Hostinger (the frontend)
api.career.tiesverse.com   → this Django app on EC2 (gunicorn → nginx → HTTPS)
```

The frontend calls the API cross-origin; `SimpleCorsMiddleware` already returns
`Access-Control-Allow-Origin: *`, and auth is a token in the request body (no
cookies), so no CORS/credentials work is needed.

---

## 0. DNS (do this first so certbot can validate)

Add an **A record**: `api.career.tiesverse.com` → your EC2 public IP.
Open the EC2 security group to inbound **80** and **443**.

---

## 1. Server setup (run on the EC2 box)

```bash
sudo apt update && sudo apt install -y python3-venv nginx
git clone https://github.com/webinarties-tech/tiesverse-career-page.git
cd tiesverse-career-page/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. Configuration

```bash
cp deploy/env.example env        # backend/env  (gitignored)
nano env                         # fill in real Cloudflare/SES values + secret
python -c "import secrets; print(secrets.token_urlsafe(50))"   # for DJANGO_SECRET_KEY
```

Make sure `env` has `DJANGO_DEBUG=False` and
`DJANGO_ALLOWED_HOSTS=api.career.tiesverse.com`.

```bash
python manage.py migrate         # local sessions/admin_sessions tables (sqlite)
python manage.py check --deploy  # sanity check
```

> Candidate data lives in Cloudflare D1 (not the local DB), so no candidate
> migration is needed — only Django's own session/admin_session tables.

## 3. gunicorn service

```bash
sudo cp deploy/career-api.service /etc/systemd/system/career-api.service
# edit paths/User in the file if you didn't clone to /home/ubuntu
sudo systemctl daemon-reload
sudo systemctl enable --now career-api
sudo systemctl status career-api        # should be active (running)
curl -s localhost:8011/api/?action=GET_PUBLIC_FORM_GATES   # smoke test
```

## 4. nginx + HTTPS

```bash
sudo cp deploy/career-api.nginx.conf /etc/nginx/sites-available/career-api
sudo ln -s /etc/nginx/sites-available/career-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.career.tiesverse.com   # auto-configures 443 + redirect
```

## 5. Point the frontend at the API

`tv-config.js` already targets `https://api.career.tiesverse.com/api/` in
production. Confirm that subdomain matches what you set up, then (re)upload the
static frontend (repo root: `*.html`, `tv-config.js`, `tv-guard.js`,
`tiesverse-theme.css`, images) to Hostinger at `career.tiesverse.com`.

## 6. Verify end-to-end

- Open `https://career.tiesverse.com`, submit a test application.
- Network tab: the POST goes to `https://api.career.tiesverse.com/api/` and
  returns `{"status":"success"}`.
- Confirm the row appears in Cloudflare D1 and the SES confirmation email sends.

---

## Updating later

```bash
cd ~/tiesverse-career-page && git pull
cd backend && source .venv/bin/activate && pip install -r requirements.txt
python manage.py migrate
sudo systemctl restart career-api
```
