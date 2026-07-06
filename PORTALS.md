# Portals Guide

This project deploys three separate web portals from one production frontend codebase: `apps/client`.

| Public host | Portal | Internal id | Build output |
| --- | --- | --- | --- |
| `app.jet-web.ir` | Merchant / پنل فروشنده | `merchant` | `dist-merchant` |
| `admin.jet-web.ir` | Admin / پنل مدیریت | `admin` | `dist-admin` |
| `partner.jet-web.ir` | Partner / پنل بازاریاب | `affiliate` | `dist-affiliate` |

`partner` is the public subdomain name. In code, database/auth contracts, and API routes, the same portal is called `affiliate`.

## Architecture

- Frontend: `apps/client`
- Backend API: `services/api`
- WordPress/WooCommerce plugin: `wordpress-plugin`

There is no separate production `apps/admin` and no separate production `apps/api`. Those parallel surfaces were removed to keep the repository direct and unambiguous.

## Backend routes

The single backend serves all portals and enforces portal isolation server-side:

```text
/auth       shared OTP/session endpoints
/merchant   merchant portal data and store workflows
/admin      platform admin data and operations
/affiliate  partner/affiliate data, referrals, commissions, payouts
/plugin     signed WordPress plugin transport
/webhooks   external webhook receivers
/billing    platform billing
```

## Production build

Use the clean production scripts so each portal gets its own isolated bundle, runtime config, and service-worker cache:

```bash
cd apps/client
npm run export:web:merchant:production:clean
npm run export:web:admin:production:clean
npm run export:web:affiliate:production:clean
```

Deploy:

```text
apps/client/dist-merchant   -> app.jet-web.ir
apps/client/dist-admin      -> admin.jet-web.ir
apps/client/dist-affiliate  -> partner.jet-web.ir
```

## Required production config

Backend environment:

```env
NODE_ENV=production
PUBLIC_API_BASE_URL=https://api.jet-web.ir
CORS_ORIGINS=https://app.jet-web.ir,https://admin.jet-web.ir,https://partner.jet-web.ir
PORTAL_MERCHANT_URL=https://app.jet-web.ir
PORTAL_AFFILIATE_URL=https://partner.jet-web.ir
```

Each deployed frontend must expose a matching `/config.json`:

```json
{ "apiBaseUrl": "https://api.jet-web.ir", "portal": "merchant" }
```

```json
{ "apiBaseUrl": "https://api.jet-web.ir", "portal": "admin" }
```

```json
{ "apiBaseUrl": "https://api.jet-web.ir", "portal": "affiliate" }
```

## Contributor rule

When adding a portal feature, modify only `apps/client` and the matching route/service in `services/api`. Do not introduce a second app or second API surface.
