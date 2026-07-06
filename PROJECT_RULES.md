# PROJECT_RULES

This repository has one production frontend codebase and one production backend. Keep it simple.

## Production deployment map

| Public host | Source | Build/runtime identity |
| --- | --- | --- |
| `app.jet-web.ir` | `apps/client` | `EXPO_PUBLIC_PORTAL=merchant` |
| `admin.jet-web.ir` | `apps/client` | `EXPO_PUBLIC_PORTAL=admin` |
| `partner.jet-web.ir` | `apps/client` | `EXPO_PUBLIC_PORTAL=affiliate` |
| `api.jet-web.ir` | `services/api` | Node/Express API |

`partner` is only the public subdomain name. The internal portal id is `affiliate` in frontend, backend, auth, and database code.

## Source ownership

- `apps/client` is the only production frontend for merchant, admin, and partner portals.
- `services/api` is the only production backend. All Express routes, DB logic, auth, RBAC, billing, plugin sync, webhooks, onboarding, and support workflows belong here.
- `wordpress-plugin` is the only WordPress/WooCommerce companion plugin.
- Do not recreate `apps/admin` or `apps/api`. Those parallel/mock/contract surfaces were removed because they confused the production architecture.

## Editing rules for AI and contributors

1. Before changing code, list the exact files to be changed.
2. Do not perform broad refactors unless explicitly requested.
3. Do not add a second backend, a second admin app, or a second portal source tree.
4. Do not move routes between portals without explicit approval.
5. Do not change package, Vercel, Expo, Metro, TypeScript, or runtime config files unless the task requires it.
6. Keep production secrets out of git and out of frontend bundles.
7. Frontend calls only `services/api`; it must never call merchant WooCommerce stores directly with secrets.

## Correct build commands

```bash
cd apps/client
npm run export:web:merchant:production:clean
npm run export:web:admin:production:clean
npm run export:web:affiliate:production:clean
```

Deploy the resulting folders as follows:

```text
dist-merchant   -> app.jet-web.ir
dist-admin      -> admin.jet-web.ir
dist-affiliate  -> partner.jet-web.ir
```
