# راهنمای خلاصه راه‌اندازی روی سرور

این پروژه روی سرور به این شکل اجرا می‌شود:

```text
api.yourdomain.ir      -> services/api
app.yourdomain.ir      -> apps/client/dist-merchant
admin.yourdomain.ir    -> apps/client/dist-admin
partner.yourdomain.ir  -> apps/client/dist-affiliate
```

در کد، پنل `partner` با شناسه داخلی `affiliate` شناخته می‌شود.

## ۱) DNS

چهار رکورد A به IP سرور بزنید:

```text
api.yourdomain.ir      -> YOUR_SERVER_IP
app.yourdomain.ir      -> YOUR_SERVER_IP
admin.yourdomain.ir    -> YOUR_SERVER_IP
partner.yourdomain.ir  -> YOUR_SERVER_IP
```

## ۲) پکیج‌های سرور

```bash
apt update && apt upgrade -y
apt install -y curl git ufw fail2ban unzip build-essential nginx postgresql postgresql-contrib
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
apt install -y nodejs
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

پورت `8080` را عمومی باز نکنید؛ API فقط پشت Nginx باشد.

## ۳) دیتابیس

```bash
sudo -u postgres psql <<'SQL'
CREATE USER portal_app WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE portal OWNER portal_app;
GRANT ALL PRIVILEGES ON DATABASE portal TO portal_app;
SQL
```

`DATABASE_URL`:

```env
DATABASE_URL=postgres://portal_app:CHANGE_ME_STRONG_PASSWORD@localhost:5432/portal
```

## ۴) کلون و نصب API

```bash
mkdir -p /var/www/portal
cd /var/www/portal
git clone https://github.com/YOUR_ORG/YOUR_REPO.git .
cd services/api
npm ci
npm run build
```

## ۵) فایل env بک‌اند

```bash
cd /var/www/portal/services/api
cp .env.example .env
nano .env
```

حداقل مقادیر production:

```env
NODE_ENV=production
PORT=8080
DATABASE_URL=postgres://portal_app:CHANGE_ME_STRONG_PASSWORD@localhost:5432/portal

JWT_SECRET=CHANGE_ME_WITH_OPENSSL_RAND_HEX_32
OTP_HASH_SECRET=CHANGE_ME_WITH_OPENSSL_RAND_HEX_32
CREDENTIAL_ENCRYPTION_KEY=CHANGE_ME_WITH_OPENSSL_RAND_HEX_32

PUBLIC_API_BASE_URL=https://api.yourdomain.ir
CORS_ORIGINS=https://app.yourdomain.ir,https://admin.yourdomain.ir,https://partner.yourdomain.ir
PORTAL_MERCHANT_URL=https://app.yourdomain.ir
PORTAL_AFFILIATE_URL=https://partner.yourdomain.ir

ADMIN_MOBILE_ALLOWLIST=09121234567
AFFILIATE_OPEN_SIGNUP=true

SMS_DRY_RUN=false
IPPANEL_API_KEY=...
IPPANEL_PATTERN_CODE=...
IPPANEL_ORIGINATOR=3000xxxx
IPPANEL_OTP_VARIABLE=code
IPPANEL_AUTH_SCHEME=accesskey
```

برای ساخت secret:

```bash
openssl rand -hex 32
```

## ۶) مایگریشن و تست API

```bash
cd /var/www/portal/services/api
npm run migrate
npm start
curl -s http://127.0.0.1:8080/health
```

## ۷) systemd برای API

```bash
sudo cp /var/www/portal/services/api/deploy/portal-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable portal-api
sudo systemctl start portal-api
sudo systemctl status portal-api
```

## ۸) بیلد سه پنل

حتماً از اسکریپت‌های clean production استفاده کنید تا bundle و service worker پنل‌ها با هم قاطی نشوند:

```bash
cd /var/www/portal/apps/client
npm ci
npm run export:web:merchant:production:clean
npm run export:web:admin:production:clean
npm run export:web:affiliate:production:clean
```

خروجی‌ها:

```text
dist-merchant   -> app
dist-admin      -> admin
dist-affiliate  -> partner
```

## ۹) کپی خروجی‌ها برای Nginx

```bash
sudo mkdir -p /var/www/portal-web/{app,admin,partner}
sudo cp -r /var/www/portal/apps/client/dist-merchant/*  /var/www/portal-web/app/
sudo cp -r /var/www/portal/apps/client/dist-admin/*     /var/www/portal-web/admin/
sudo cp -r /var/www/portal/apps/client/dist-affiliate/* /var/www/portal-web/partner/
sudo chown -R www-data:www-data /var/www/portal-web
```

## ۱۰) Nginx

برای API، reverse proxy به `127.0.0.1:8080` بدهید. برای سه پنل، rootها این‌ها هستند:

```text
app.yourdomain.ir      root /var/www/portal-web/app
admin.yourdomain.ir    root /var/www/portal-web/admin
partner.yourdomain.ir  root /var/www/portal-web/partner
```

در کانفیگ هر پنل، SPA fallback لازم است:

```nginx
try_files $uri $uri/ /index.html;
```

## ۱۱) SSL

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx \
  -d api.yourdomain.ir \
  -d app.yourdomain.ir \
  -d admin.yourdomain.ir \
  -d partner.yourdomain.ir
```

## ۱۲) تست نهایی

```bash
curl https://api.yourdomain.ir/health
```

بعد در مرورگر باز کنید:

```text
https://app.yourdomain.ir
https://admin.yourdomain.ir
https://partner.yourdomain.ir
```

تست OTP:

```bash
curl -s https://api.yourdomain.ir/auth/otp/request \
  -H 'content-type: application/json' \
  -d '{"mobile":"09121234567","portal":"admin"}'
```

## ۱۳) آپدیت بعدی

```bash
cd /var/www/portal
git pull

cd services/api
npm ci
npm run build
npm run migrate
sudo systemctl restart portal-api

cd ../../apps/client
npm ci
npm run export:web:merchant:production:clean
npm run export:web:admin:production:clean
npm run export:web:affiliate:production:clean
sudo cp -r dist-merchant/*  /var/www/portal-web/app/
sudo cp -r dist-admin/*     /var/www/portal-web/admin/
sudo cp -r dist-affiliate/* /var/www/portal-web/partner/
```

## قانون مهم

- production frontend فقط `apps/client` است.
- production backend فقط `services/api` است.
- پنل partner در کد همان `affiliate` است.
- فولدر موازی برای admin یا API نسازید.
