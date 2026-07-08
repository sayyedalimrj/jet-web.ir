/**
 * Merchant routes (merchant portal). Everything is scoped to the caller's tenant + site, with
 * per-site access guards before every call. Reads are served from normalized read-models (fast,
 * paginated); details and reports can read live from WooCommerce (cached). WooCommerce credentials
 * are looked up + decrypted server-side and never leave the backend.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';

import { env } from '../../env';
import { canManage, primaryTenantId } from '../../services/accessControl';
import { audit } from '../../services/audit';
import { query, queryOne } from '../../db';
import { cached, invalidate } from '../../util/cache';
import { parsePagination } from '../../util/pagination';
import { badRequest, forbidden, notFound } from '../../util/errors';
import {
  disconnectSite,
  getSite,
  getWooCredentials,
  listSites,
  resyncProduct,
  rotatePluginSigningSecret,
  setWooWebhookSecret,
  startConnection,
  startSiteSync,
  updateSiteSettings,
  verifyWooConnection,
  type SiteRow,
} from '../../services/sites';
import {
  getOrder,
  getProduct,
  getSalesReport,
  createProduct,
  deleteProduct,
  listProducts,
  setProductImages,
  uploadProductMedia,
  updateOrderStatus,
  updateProduct,
  updateProductStock,
  type NormalizedProduct,
} from '../../services/woocommerce/wooClient';
import { authenticate, requirePortal, type AuthedRequest } from '../middleware/auth';
import { asyncHandler } from '../asyncHandler';
import {
  addMessage as addSupportMessage,
  createTicket as createSupportTicket,
  getMessages as getSupportMessages,
  getTicket as getSupportTicket,
  listTickets as listSupportTickets,
  markRead as markSupportRead,
  unreadCount as supportUnreadCount,
} from '../../services/supportService';
import {
  createOnboardingRequest,
  getOnboardingRequestForTenant,
  listNotifications,
  listOnboardingRequestsForTenant,
  listOnboardingStatusEvents,
  markNotificationRead,
  unreadNotificationCount,
  validateReferralCode,
} from '../../services/onboardingService';
import {
  createSocialConnection,
  disconnectSocialConnection,
  enqueueProductPublishJob,
  listPublishJobs,
  listSocialConnections,
  testSocialConnection,
  type SocialPlatform,
} from '../../services/social/socialService';

export const merchantRouter = Router();
merchantRouter.use(authenticate, requirePortal('merchant'));

/** Resolve the caller's tenant (from the token, else their membership). */
async function tenantFor(req: AuthedRequest): Promise<string> {
  const fromToken = req.auth?.tenantId;
  if (fromToken) return fromToken;
  const resolved = await primaryTenantId(req.auth!.sub);
  if (!resolved) throw notFound('فروشگاهی برای این حساب یافت نشد.');
  return resolved;
}

/** Resolve + access-guard a site that must belong to the caller's tenant. */
async function siteFor(req: AuthedRequest, siteId: string): Promise<SiteRow> {
  const tenantId = await tenantFor(req);
  const site = await getSite(siteId);
  if (!site || site.tenant_id !== tenantId) throw notFound('فروشگاه یافت نشد.');
  return site;
}

function ensureManage(req: AuthedRequest): void {
  if (!canManage(req.auth!.role)) throw forbidden('برای این عملیات دسترسی کافی ندارید.');
}

function mapOrderApi(o: Record<string, unknown>) {
  return {
    external_id: o.external_id,
    number: o.number,
    status: o.status,
    total_minor: o.total_minor,
    subtotal_minor: o.subtotal_minor ?? o.total_minor,
    tax_minor: o.tax_minor ?? 0,
    shipping_minor: o.shipping_minor ?? 0,
    discount_minor: o.discount_minor ?? 0,
    currency: o.currency,
    customer_name: o.customer_name,
    payment_method: o.payment_method,
    line_items: o.line_items ?? [],
    billing: o.billing ?? null,
    shipping_address: o.shipping_address ?? null,
    external_created_at: o.external_created_at,
  };
}

/** Map a live WooCommerce product to the merchant list read-model (matches synced_product list shape). */
function mapLiveProductListItem(p: NormalizedProduct, site: SiteRow) {
  return {
    external_id: p.externalId,
    name: p.name,
    sku: p.sku,
    status: p.status,
    type: p.type,
    price_minor: p.priceMinor,
    regular_price_minor: p.regularPriceMinor,
    sale_price_minor: p.salePriceMinor,
    currency: p.currency || site.currency,
    stock_status: p.stockStatus,
    stock_qty: p.stockQty,
    updated_at: new Date().toISOString(),
    permalink: p.permalink,
    image_src: p.images[0]?.src ?? null,
    variations_count: null,
    images_count: p.images.length,
    sync_source: 'woo_rest',
    sync_status: 'synced',
    last_synced_at: new Date().toISOString(),
  };
}

/** Fill missing calendar days so chart buckets align with the selected range. */
function fillDailySeries<T extends { day: string }>(
  rows: T[],
  days: number,
  empty: Omit<T, 'day'>,
): T[] {
  const byDay = new Map<string, T>();
  for (const row of rows) {
    const key = String(row.day).slice(0, 10);
    byDay.set(key, { ...row, day: key });
  }
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const out: T[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? ({ ...empty, day: key } as T));
  }
  return out;
}

function mapLiveOrder(o: Awaited<ReturnType<typeof getOrder>>) {
  return {
    external_id: o.externalId,
    number: o.number,
    status: o.status,
    total_minor: o.totalMinor,
    subtotal_minor: o.subtotalMinor,
    tax_minor: o.taxMinor,
    shipping_minor: o.shippingMinor,
    discount_minor: o.discountMinor,
    currency: o.currency,
    customer_name: o.customerName,
    payment_method: o.paymentMethodTitle,
    line_items: o.lineItems,
    billing: o.billing,
    shipping_address: o.shipping,
    external_created_at: o.createdAt,
  };
}

// ---- tenant overview ----

merchantRouter.get(
  '/overview',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = await tenantFor(req);
    const overview = await cached(`merchant:overview:${tenantId}`, async () =>
      queryOne(
        `SELECT
           (SELECT count(*) FROM site WHERE tenant_id = $1 AND status = 'connected')::int AS connected_sites,
           (SELECT count(*) FROM site WHERE tenant_id = $1)::int AS total_sites,
           (SELECT count(*) FROM synced_product WHERE tenant_id = $1)::int AS products,
           (SELECT count(*) FROM synced_order WHERE tenant_id = $1)::int AS orders,
           (SELECT count(*) FROM synced_customer WHERE tenant_id = $1)::int AS customers,
           (SELECT COALESCE(sum(total_minor),0) FROM synced_order WHERE tenant_id = $1 AND status NOT IN ('cancelled','refunded','failed'))::bigint AS gross_minor`,
        [tenantId],
      ),
    );
    res.json({ overview });
  }),
);

// ---- site connection lifecycle ----

merchantRouter.get(
  '/sites',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = await tenantFor(req);
    res.json({ sites: await listSites(tenantId) });
  }),
);

const startSchema = z.object({
  name: z.string().trim().min(1).max(160),
  url: z.string().trim().min(3).max(300),
  mode: z.enum(['woo_rest', 'plugin']).default('woo_rest'),
});

merchantRouter.post(
  '/sites/connect/start',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('نام و آدرس فروشگاه را درست وارد کنید.');
    const tenantId = await tenantFor(req);
    const result = await startConnection({ tenantId, ...parsed.data });
    await audit({
      actorUserId: req.auth!.sub,
      action: 'site.connect.start',
      targetType: 'site',
      targetId: result.siteId,
      requestIp: req.ip,
      meta: { mode: parsed.data.mode },
    });
    invalidate(`merchant:overview:${tenantId}`);
    // signingSecret (plugin mode) is returned EXACTLY ONCE here; it is never retrievable again.
    // tenantId + siteId + the delivery URL are what the merchant pastes into the WordPress plugin.
    res.json({
      siteId: result.siteId,
      tenantId,
      connectionId: result.connectionId,
      mode: parsed.data.mode,
      deliveryBaseUrl: `${env.PUBLIC_API_BASE_URL || ''}/plugin`,
      ...(result.signingSecret ? { signingSecret: result.signingSecret } : {}),
    });
  }),
);

// A real WooCommerce key never contains the mask glyph (•) and is never all asterisks. Rejecting
// masked placeholders guarantees the frontend's "••••••" display can never be sent as a real
// secret (which would otherwise fail Woo auth and could be mistaken for a credential change).
const notMasked = (v: string): boolean => !/[\u2022•]/.test(v) && !/^[*]+$/.test(v.trim());
const verifySchema = z.object({
  siteId: z.string().uuid(),
  consumerKey: z.string().trim().min(8).max(200).refine(notMasked, 'masked_placeholder'),
  consumerSecret: z.string().trim().min(8).max(200).refine(notMasked, 'masked_placeholder'),
});

merchantRouter.post(
  '/sites/connect/verify',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('اطلاعات اتصال ناقص است.');
    const site = await siteFor(req, parsed.data.siteId);
    const tenantId = site.tenant_id;
    const updated = await verifyWooConnection({
      siteId: site.id,
      tenantId,
      consumerKey: parsed.data.consumerKey,
      consumerSecret: parsed.data.consumerSecret,
    });
    await audit({
      actorUserId: req.auth!.sub,
      action: 'site.connect.verify',
      targetType: 'site',
      targetId: site.id,
      requestIp: req.ip,
      meta: { status: updated.status },
    });
    invalidate(`merchant:overview:${tenantId}`);
    res.json({ site: updated });
  }),
);

merchantRouter.get(
  '/sites/:siteId/status',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const plugin = await queryOne(
      `SELECT status, plugin_version, last_seen_at, last_sync_at, last_event_at
         FROM plugin_connection WHERE site_id = $1`,
      [site.id],
    );
    const lastSync = await queryOne(
      `SELECT status, stats, error, started_at, finished_at, phase, progress_percent
         FROM sync_run WHERE site_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [site.id],
    );
    const counts = await queryOne<{
      products: number;
      orders: number;
      customers: number;
      coupons: number;
      categories: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM synced_product WHERE site_id = $1) AS products,
         (SELECT count(*)::int FROM synced_order WHERE site_id = $1) AS orders,
         (SELECT count(*)::int FROM synced_customer WHERE site_id = $1) AS customers,
         (SELECT count(*)::int FROM synced_coupon WHERE site_id = $1) AS coupons,
         (SELECT count(*)::int FROM synced_category WHERE site_id = $1) AS categories`,
      [site.id],
    );
    res.json({
      site,
      plugin,
      lastSync,
      syncedCounts: counts ?? { products: 0, orders: 0, customers: 0, coupons: 0, categories: 0 },
      deliveryBaseUrl: `${env.PUBLIC_API_BASE_URL || ''}/plugin`,
    });
  }),
);

const siteEditSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    url: z.string().trim().min(3).max(300).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'هیچ تغییری ارسال نشده است.' });

merchantRouter.patch(
  '/sites/:siteId',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    const parsed = siteEditSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('اطلاعات فروشگاه نامعتبر است.');
    const updated = await updateSiteSettings(site.id, site.tenant_id, parsed.data);
    await audit({
      actorUserId: req.auth!.sub,
      action: 'site.settings.update',
      targetType: 'site',
      targetId: site.id,
      requestIp: req.ip,
      meta: { fields: Object.keys(parsed.data), status: updated.status },
    });
    invalidate(`merchant:overview:${site.tenant_id}`);
    // Never returns secrets; if the host changed, status is now 'pending' (re-verify required).
    res.json({ site: updated });
  }),
);

merchantRouter.post(
  '/sites/:siteId/disconnect',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    await disconnectSite(site.id);
    await audit({
      actorUserId: req.auth!.sub,
      action: 'site.disconnect',
      targetType: 'site',
      targetId: site.id,
      requestIp: req.ip,
    });
    invalidate(`merchant:overview:${site.tenant_id}`);
    res.json({ ok: true });
  }),
);

merchantRouter.post(
  '/sites/:siteId/plugin/rotate-secret',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    if (site.connection_mode !== 'plugin') {
      throw badRequest('چرخش کلید فقط برای اتصال افزونه است.');
    }
    const signingSecret = await rotatePluginSigningSecret(site.id, site.tenant_id);
    await audit({
      actorUserId: req.auth!.sub,
      action: 'plugin.secret.rotated',
      targetType: 'site',
      targetId: site.id,
      requestIp: req.ip,
    });
    invalidate(`merchant:overview:${site.tenant_id}`);
    res.json({
      signingSecret,
      siteId: site.id,
      tenantId: site.tenant_id,
      deliveryBaseUrl: `${env.PUBLIC_API_BASE_URL || ''}/plugin`,
    });
  }),
);

merchantRouter.post(
  '/sites/:siteId/webhook-secret',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    const secret = await setWooWebhookSecret(site.id, site.tenant_id);
    await audit({
      actorUserId: req.auth!.sub,
      action: 'site.webhook_secret.rotate',
      targetType: 'site',
      targetId: site.id,
      requestIp: req.ip,
    });
    // Returned ONCE; configure this as the WooCommerce webhook "Secret".
    res.json({
      secret,
      deliveryUrl: `${env.PUBLIC_API_BASE_URL || ''}/webhooks/woocommerce/${site.id}`,
    });
  }),
);

merchantRouter.post(
  '/sites/:siteId/sync',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    if (site.connection_mode !== 'woo_rest') {
      throw badRequest('همگام‌سازی دستی فقط برای اتصال REST است؛ افزونه خودش داده می‌فرستد.');
    }
    // Do not start a duplicate parallel sync for the same site — return the in-flight one. A run
    // that has not progressed in 30 min is treated as stale (process likely died) so it can never
    // block syncing forever: it is cancelled and a fresh run starts.
    await query(
      `UPDATE sync_run SET status = 'cancelled', message = 'همگام‌سازی متوقف شد (بدون پیشرفت)', finished_at = now()
         WHERE site_id = $1 AND status IN ('queued', 'running') AND started_at < now() - interval '30 minutes'`,
      [site.id],
    );
    const inFlight = await queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM sync_run
         WHERE site_id = $1 AND status IN ('queued', 'running')
         ORDER BY started_at DESC LIMIT 1`,
      [site.id],
    );
    if (inFlight) {
      res.status(202).json({ ok: true, status: inFlight.status, syncRunId: inFlight.id, alreadyRunning: true });
      return;
    }
    // Start the sync in the background and return immediately — never block the UI on a full pull.
    // Progress/result are recorded on sync_run + the site row and exposed via the status endpoint.
    startSiteSync(site.id);
    await audit({
      actorUserId: req.auth!.sub,
      action: 'site.sync.start',
      targetType: 'site',
      targetId: site.id,
      requestIp: req.ip,
      meta: {},
    });
    res.status(202).json({ ok: true, status: 'running' });
  }),
);

merchantRouter.get(
  '/sites/:siteId/sync/status',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    // Most recent run (any status) with full progress + counters.
    const run = await queryOne(
      `SELECT id, status, phase, message, progress_percent, error AS last_error,
              started_at, finished_at,
              products_total, products_done, orders_total, orders_done,
              customers_total, customers_done, coupons_total, coupons_done,
              media_total, media_done, stats
         FROM sync_run WHERE site_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [site.id],
    );
    const lastSuccess = await queryOne<{ finished_at: string }>(
      `SELECT finished_at FROM sync_run
         WHERE site_id = $1 AND status = 'success' ORDER BY finished_at DESC LIMIT 1`,
      [site.id],
    );
    res.json({
      run,
      lastSuccessAt: lastSuccess?.finished_at ?? site.last_synced_at ?? null,
      siteStatus: site.status,
      lastError: site.last_error ?? null,
    });
  }),
);

merchantRouter.delete(
  '/sites/:siteId',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    // Soft delete: revoke this site's stored credentials + mark the local connection disconnected.
    // The remote WooCommerce/WordPress store is NEVER touched; historical synced read-models are
    // kept for reporting. The merchant can reconnect later with fresh keys.
    await disconnectSite(site.id);
    await audit({
      actorUserId: req.auth!.sub,
      action: 'site.delete',
      targetType: 'site',
      targetId: site.id,
      requestIp: req.ip,
      meta: {},
    });
    invalidate(`merchant:overview:${site.tenant_id}`);
    res.json({ ok: true });
  }),
);

// ---- site read-models ----

merchantRouter.get(
  '/sites/:siteId/overview',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const overview = await cached(`site:overview:${site.id}`, async () =>
      queryOne(
        `SELECT
           (SELECT count(*) FROM synced_product WHERE site_id = $1)::int AS products,
           (SELECT count(*) FROM synced_order WHERE site_id = $1)::int AS orders,
           (SELECT count(*) FROM synced_customer WHERE site_id = $1)::int AS customers,
           (SELECT count(*) FROM synced_coupon WHERE site_id = $1)::int AS coupons,
           (SELECT COALESCE(sum(total_minor),0) FROM synced_order WHERE site_id = $1 AND status = 'completed')::bigint AS completed_revenue_minor`,
        [site.id],
      ),
    );
    res.json({ site, overview });
  }),
);

merchantRouter.get(
  '/sites/:siteId/products',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>);
    const searchRaw = req.query.search ? String(req.query.search).trim() : '';
    const search = searchRaw || null;
    const stockStatus = req.query.stockStatus ? String(req.query.stockStatus) : null;

    // Woo REST sites: list live from WooCommerce (same as product detail). The synced read-model
    // is populated in the background and may be empty right after connect.
    const creds = await getWooCredentials(site.id);
    if (creds) {
      const wooPage = await listProducts(creds, {
        page,
        pageSize,
        search: search ?? undefined,
        stockStatus: stockStatus ?? undefined,
        status: req.query.status ? String(req.query.status) : undefined,
      });
      res.json({
        items: wooPage.items.map((p) => mapLiveProductListItem(p, site)),
        page: wooPage.page,
        pageSize: wooPage.pageSize,
        total: wooPage.total,
        hasNext: wooPage.page * wooPage.pageSize < wooPage.total,
      });
      return;
    }

    const items = await query(
      `SELECT p.external_id, p.name, p.sku, p.status, p.type, p.price_minor, p.currency,
              p.stock_status, p.stock_qty, p.updated_at, p.permalink,
              (SELECT src FROM synced_product_image i WHERE i.product_id = p.id
                 ORDER BY i.position ASC LIMIT 1) AS image_src,
              (SELECT count(*)::int FROM synced_product_variant v WHERE v.product_id = p.id) AS variations_count,
              (SELECT count(*)::int FROM synced_product_image i2 WHERE i2.product_id = p.id) AS images_count,
              COALESCE(
                (SELECT sc.connection_mode FROM site_connection sc
                   WHERE sc.site_id = p.site_id AND sc.status = 'connected'
                   ORDER BY sc.updated_at DESC LIMIT 1),
                'woo_rest'
              ) AS sync_source,
              'synced' AS sync_status,
              p.updated_at AS last_synced_at
         FROM synced_product p
        WHERE p.site_id = $1
          AND ($2::text IS NULL OR p.name ILIKE $2 OR p.sku ILIKE $2)
          AND ($5::text IS NULL OR p.stock_status = $5)
        ORDER BY p.updated_at DESC LIMIT $3 OFFSET $4`,
      [site.id, search ? `%${search}%` : null, pageSize, offset, stockStatus],
    );
    const total = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM synced_product
         WHERE site_id = $1
           AND ($2::text IS NULL OR name ILIKE $2 OR sku ILIKE $2)
           AND ($3::text IS NULL OR stock_status = $3)`,
      [site.id, search ? `%${search}%` : null, stockStatus],
    );
    const count = total?.count ?? 0;
    res.json({
      items,
      page,
      pageSize,
      total: count,
      hasNext: page * pageSize < count,
    });
  }),
);

merchantRouter.get(
  '/sites/:siteId/products/:productId',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const creds = await getWooCredentials(site.id);
    const adminEditUrl = `${site.url.replace(/\/+$/, '')}/wp-admin/post.php?post=${encodeURIComponent(req.params.productId)}&action=edit`;
    if (creds) {
      const p = await getProduct(creds, req.params.productId);
      res.json({
        product: {
          external_id: p.externalId,
          name: p.name,
          sku: p.sku,
          status: p.status,
          type: p.type,
          permalink: p.permalink,
          admin_edit_url: adminEditUrl,
          price_minor: p.priceMinor,
          regular_price_minor: p.regularPriceMinor,
          sale_price_minor: p.salePriceMinor,
          currency: p.currency,
          stock_status: p.stockStatus,
          stock_qty: p.stockQty,
          categories: p.categories.map((c) => ({ external_id: c.externalId, name: c.name })),
          tags: p.tags.map((tg) => ({ external_id: tg.externalId, name: tg.name })),
          images: p.images.map((i) => ({ src: i.src, alt: i.alt, position: i.position })),
        },
      });
      return;
    }
    const product = await queryOne<{ id: string } & Record<string, unknown>>(
      `SELECT id, external_id, name, sku, status, type, permalink, price_minor, currency,
              stock_status, stock_qty, meta, raw, updated_at
         FROM synced_product WHERE site_id = $1 AND external_id = $2`,
      [site.id, req.params.productId],
    );
    if (!product) throw notFound('محصول یافت نشد.');
    const productId = product.id as string;
    const images = await query(
      `SELECT external_id, src, alt, position FROM synced_product_image
         WHERE product_id = $1 ORDER BY position ASC`,
      [productId],
    );
    const categories = await query(
      `SELECT c.external_id, c.name FROM synced_product_category pc
         JOIN synced_category c ON c.id = pc.category_id
        WHERE pc.product_id = $1`,
      [productId],
    );
    const tags = await query(
      `SELECT t.external_id, t.name FROM synced_product_tag pt
         JOIN synced_tag t ON t.id = pt.tag_id
        WHERE pt.product_id = $1`,
      [productId],
    );
    const attributes = await query(
      `SELECT external_id, name, options, is_visible, is_variation
         FROM synced_product_attribute WHERE product_id = $1 ORDER BY position ASC`,
      [productId],
    );
    const variants = await query(
      `SELECT external_id, sku, price_minor, currency, stock_status, stock_qty, attributes
         FROM synced_product_variant WHERE product_id = $1 ORDER BY updated_at DESC`,
      [productId],
    );
    const connection = await queryOne<{ connection_mode: string }>(
      `SELECT connection_mode FROM site_connection
         WHERE site_id = $1 AND status = 'connected' ORDER BY updated_at DESC LIMIT 1`,
      [site.id],
    );
    const meta = (product.meta ?? {}) as Record<string, unknown>;
    const raw = (product.raw ?? {}) as Record<string, unknown>;
    const { id: _id, meta: _m, raw: _r, ...productPublic } = product;
    void _id;
    void _m;
    void _r;
    res.json({
      product: {
        ...productPublic,
        admin_edit_url: adminEditUrl,
        regular_price_minor: meta.regular_price_minor ?? raw.regular_price ?? product.price_minor,
        sale_price_minor: meta.sale_price_minor ?? raw.sale_price ?? null,
        total_sales: meta.total_sales ?? raw.total_sales ?? null,
        average_rating: meta.average_rating ?? raw.average_rating ?? null,
        rating_count: meta.rating_count ?? raw.rating_count ?? null,
        variations_count: variants.length,
        images_count: images.length,
        sync_source: connection?.connection_mode ?? 'plugin',
        sync_status: 'synced',
        last_synced_at: product.updated_at,
        images,
        categories,
        tags,
        attributes,
        variants,
      },
    });
  }),
);

merchantRouter.get(
  '/sites/:siteId/categories',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>);
    const items = await query(
      `SELECT external_id, parent_external_id, name, slug, updated_at
         FROM synced_category WHERE site_id = $1 ORDER BY name ASC LIMIT $2 OFFSET $3`,
      [site.id, pageSize, offset],
    );
    const total = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM synced_category WHERE site_id = $1`,
      [site.id],
    );
    res.json({ items, page, pageSize, total: total?.count ?? 0 });
  }),
);

merchantRouter.get(
  '/sites/:siteId/orders',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>);
    const status = req.query.status ? String(req.query.status) : null;
    const items = await query(
      `SELECT external_id, number, status, total_minor, currency, customer_name, external_created_at
         FROM synced_order
        WHERE site_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY external_created_at DESC NULLS LAST LIMIT $3 OFFSET $4`,
      [site.id, status, pageSize, offset],
    );
    const total = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM synced_order
         WHERE site_id = $1 AND ($2::text IS NULL OR status = $2)`,
      [site.id, status],
    );
    res.json({ items, page, pageSize, total: total?.count ?? 0 });
  }),
);

merchantRouter.get(
  '/sites/:siteId/orders/:orderId',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const creds = await getWooCredentials(site.id);
    if (creds) {
      const o = await getOrder(creds, req.params.orderId);
      res.json({ order: mapLiveOrder(o) });
      return;
    }
    const order = await queryOne(
      `SELECT external_id, number, status, total_minor, subtotal_minor, tax_minor, shipping_minor,
              discount_minor, currency, customer_name, payment_method, line_items, billing,
              shipping_address, external_created_at
         FROM synced_order WHERE site_id = $1 AND external_id = $2`,
      [site.id, req.params.orderId],
    );
    if (!order) throw notFound('سفارش یافت نشد.');
    res.json({ order: mapOrderApi(order as Record<string, unknown>) });
  }),
);

merchantRouter.get(
  '/sites/:siteId/customers',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>);
    const items = await query(
      `SELECT external_id, display_name, orders_count, total_spent_minor, currency, updated_at
         FROM synced_customer WHERE site_id = $1 ORDER BY total_spent_minor DESC LIMIT $2 OFFSET $3`,
      [site.id, pageSize, offset],
    );
    const total = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM synced_customer WHERE site_id = $1`,
      [site.id],
    );
    res.json({ items, page, pageSize, total: total?.count ?? 0 });
  }),
);

merchantRouter.get(
  '/sites/:siteId/customers/:customerId',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const customer = await queryOne(
      `SELECT external_id, display_name, email, phone, username, orders_count, total_spent_minor,
              currency, external_created_at, updated_at
         FROM synced_customer WHERE site_id = $1 AND external_id = $2`,
      [site.id, req.params.customerId],
    );
    if (!customer) throw notFound('مشتری یافت نشد.');
    const recentOrders = await query(
      `SELECT external_id, number, status, total_minor, currency, external_created_at
         FROM synced_order
        WHERE site_id = $1 AND customer_name ILIKE '%' || split_part($2, ' ', 1) || '%'
        ORDER BY external_created_at DESC NULLS LAST LIMIT 10`,
      [site.id, (customer as { display_name?: string }).display_name ?? ''],
    );
    res.json({ customer, recentOrders });
  }),
);

merchantRouter.get(
  '/sites/:siteId/reports/overview-series',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const range = String(req.query.range ?? '7d');
    const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const salesRaw = await query(
      `SELECT date_trunc('day', external_created_at) AS day,
              count(*)::int AS orders,
              COALESCE(sum(total_minor),0)::bigint AS revenue_minor
         FROM synced_order
        WHERE site_id = $1
          AND external_created_at >= $2
          AND status NOT IN ('cancelled','refunded','failed')
        GROUP BY 1 ORDER BY 1 ASC`,
      [site.id, since],
    );
    const customersRaw = await query(
      `SELECT date_trunc('day', external_created_at) AS day,
              count(*)::int AS new_customers
         FROM synced_customer
        WHERE site_id = $1 AND external_created_at >= $2
        GROUP BY 1 ORDER BY 1 ASC`,
      [site.id, since],
    );
    const sales = fillDailySeries(
      salesRaw as { day: string; orders: number; revenue_minor: number | string }[],
      days,
      { orders: 0, revenue_minor: 0 },
    );
    const customers = fillDailySeries(
      customersRaw as { day: string; new_customers: number }[],
      days,
      { new_customers: 0 },
    );
    res.json({ range, currency: site.currency, sales, customers });
  }),
);

merchantRouter.get(
  '/sites/:siteId/coupons',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>);
    const items = await query(
      `SELECT external_id, code, discount_type, amount_minor, currency, updated_at
         FROM synced_coupon WHERE site_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
      [site.id, pageSize, offset],
    );
    const total = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM synced_coupon WHERE site_id = $1`,
      [site.id],
    );
    res.json({ items, page, pageSize, total: total?.count ?? 0 });
  }),
);

merchantRouter.get(
  '/sites/:siteId/reports/sales',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const period = (['week', 'month', 'year'] as const).includes(req.query.period as never)
      ? (req.query.period as 'week' | 'month' | 'year')
      : 'week';
    const creds = await getWooCredentials(site.id);
    if (creds) {
      const report = await cached(`site:report:${site.id}:${period}`, () =>
        getSalesReport(creds, period),
      );
      res.json({ report });
      return;
    }
    // Fallback to read-model aggregation when no live credentials (e.g. plugin mode).
    const row = await queryOne(
      `SELECT COALESCE(sum(total_minor),0)::bigint AS total_sales_minor,
              count(*)::int AS total_orders
         FROM synced_order WHERE site_id = $1 AND status = 'completed'`,
      [site.id],
    );
    res.json({ report: { period, currency: site.currency, ...row } });
  }),
);

const productCreateSchema = z.object({
  name: z.string().trim().min(1).max(300),
  sku: z.string().trim().max(100).optional(),
  regularPrice: z.string().trim().regex(/^(\d+(\.\d{1,4})?)?$/).max(20).optional(),
  status: z.enum(['publish', 'draft']).default('draft'),
  stockQuantity: z.number().int().optional(),
  description: z.string().trim().max(20000).optional(),
});

merchantRouter.post(
  '/sites/:siteId/products',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    const parsed = productCreateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('اطلاعات محصول نامعتبر است.');
    const creds = await getWooCredentials(site.id);
    if (!creds) throw badRequest('این فروشگاه اتصال REST فعال ندارد.');

    // Create in WooCommerce; the returned status is the REAL resulting status (no fake "review").
    const product = await createProduct(creds, {
      name: parsed.data.name,
      sku: parsed.data.sku,
      regularPrice: parsed.data.regularPrice,
      status: parsed.data.status,
      stockQuantity: parsed.data.stockQuantity,
      description: parsed.data.description,
    });

    // Pull the new product into the read-model so the list/detail show it immediately.
    try {
      await resyncProduct(site.id, product.externalId);
    } catch {
      /* read-model refresh is best-effort; the WooCommerce create already succeeded */
    }

    await audit({
      actorUserId: req.auth!.sub,
      action: 'product.create',
      targetType: 'product',
      targetId: product.externalId,
      requestIp: req.ip,
      meta: { siteId: site.id, status: product.status },
    });
    invalidate(`site:overview:${site.id}`);
    invalidate(`merchant:overview:${site.tenant_id}`);
    res.status(201).json({
      product: {
        external_id: product.externalId,
        name: product.name,
        sku: product.sku,
        status: product.status,
        type: product.type,
        permalink: product.permalink,
        price_minor: product.priceMinor,
        currency: product.currency,
        stock_status: product.stockStatus,
        stock_qty: product.stockQty,
      },
    });
  }),
);

// ---- controlled writes ----

const stockSchema = z.object({ stockQuantity: z.number().int() });
merchantRouter.patch(
  '/sites/:siteId/products/:productId/stock',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    const parsed = stockSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('مقدار موجودی نامعتبر است.');
    const creds = await getWooCredentials(site.id);
    if (!creds) throw badRequest('این فروشگاه اتصال REST فعال ندارد.');
    const product = await updateProductStock(creds, req.params.productId, parsed.data.stockQuantity);
    await query(
      `UPDATE synced_product SET stock_qty = $3, stock_status = $4, updated_at = now()
         WHERE site_id = $1 AND external_id = $2`,
      [site.id, req.params.productId, product.stockQty, product.stockStatus],
    );
    await audit({
      actorUserId: req.auth!.sub,
      action: 'product.stock.update',
      targetType: 'product',
      targetId: req.params.productId,
      requestIp: req.ip,
      meta: { siteId: site.id, stockQuantity: parsed.data.stockQuantity },
    });
    res.json({ product });
  }),
);

const productUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(300).optional(),
    regularPrice: z.string().trim().regex(/^\d+(\.\d{1,4})?$/).max(20).optional(),
    salePrice: z.string().trim().regex(/^(\d+(\.\d{1,4})?)?$/).max(20).optional(),
    status: z.enum(['publish', 'draft', 'pending', 'private']).optional(),
    stockQuantity: z.number().int().optional(),
    stockStatus: z.enum(['instock', 'outofstock', 'onbackorder']).optional(),
    categoryExternalIds: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
    // Images by EXISTING WooCommerce media id or already-hosted URL only (no binary upload).
    images: z
      .array(z.object({ id: z.string().trim().max(40).optional(), src: z.string().trim().url().max(2000).optional() }))
      .max(20)
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'هیچ تغییری ارسال نشده است.' });

merchantRouter.patch(
  '/sites/:siteId/products/:productId',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    const parsed = productUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('اطلاعات محصول نامعتبر است.');
    const creds = await getWooCredentials(site.id);
    if (!creds) throw badRequest('این فروشگاه اتصال REST فعال ندارد.');

    const product = await updateProduct(creds, req.params.productId, {
      name: parsed.data.name,
      regularPrice: parsed.data.regularPrice,
      salePrice: parsed.data.salePrice,
      status: parsed.data.status,
      stockQuantity: parsed.data.stockQuantity,
      manageStock: parsed.data.stockQuantity !== undefined ? true : undefined,
      stockStatus: parsed.data.stockStatus,
      categoryExternalIds: parsed.data.categoryExternalIds,
      images: parsed.data.images,
    });

    // Refresh the read-model (product + images + categories + variations) so the UI reloads real data.
    try {
      await resyncProduct(site.id, req.params.productId);
    } catch {
      /* read-model refresh is best-effort; the WooCommerce write already succeeded */
    }

    await audit({
      actorUserId: req.auth!.sub,
      action: 'product.update',
      targetType: 'product',
      targetId: req.params.productId,
      requestIp: req.ip,
      meta: {
        siteId: site.id,
        fields: Object.keys(parsed.data),
      },
    });
    res.json({
      product: {
        external_id: product.externalId,
        name: product.name,
        sku: product.sku,
        status: product.status,
        type: product.type,
        price_minor: product.priceMinor,
        currency: product.currency,
        stock_status: product.stockStatus,
        stock_qty: product.stockQty,
        categories: product.categories.map((c) => ({ external_id: c.externalId, name: c.name })),
        images: product.images.map((i) => ({ src: i.src, alt: i.alt, position: i.position })),
      },
    });
  }),
);

merchantRouter.delete(
  '/sites/:siteId/products/:productId',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    const creds = await getWooCredentials(site.id);
    if (!creds) throw badRequest('این فروشگاه اتصال REST فعال ندارد.');
    // Default = trash (soft delete, restorable in WordPress); hard delete only when ?force=true.
    const force = String(req.query.force ?? '') === 'true';
    const result = await deleteProduct(creds, req.params.productId, force);
    // Drop the local read-model row so the product disappears from the JetWeb list immediately.
    await query(`DELETE FROM synced_product WHERE site_id = $1 AND external_id = $2`, [
      site.id,
      req.params.productId,
    ]);
    await audit({
      actorUserId: req.auth!.sub,
      action: force ? 'product.delete' : 'product.trash',
      targetType: 'product',
      targetId: req.params.productId,
      requestIp: req.ip,
      meta: { siteId: site.id, force },
    });
    invalidate(`site:overview:${site.id}`);
    invalidate(`merchant:overview:${site.tenant_id}`);
    res.json({ ok: true, external_id: result.externalId, force });
  }),
);

// ---- product media (gallery) management ----

interface MediaImageOut {
  id: string | null;
  src: string;
  alt: string | null;
  position: number;
  isCover: boolean;
}
function toMediaList(images: { externalId: string | null; src: string; alt: string | null; position: number }[]): MediaImageOut[] {
  // WooCommerce treats the FIRST image as the product's cover/featured image.
  return images.map((img, i) => ({
    id: img.externalId,
    src: img.src,
    alt: img.alt,
    position: i,
    isCover: i === 0,
  }));
}

// All images for a product (not just the cover).
merchantRouter.get(
  '/sites/:siteId/products/:productId/media',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const creds = await getWooCredentials(site.id);
    if (!creds) throw badRequest('این فروشگاه اتصال REST فعال ندارد.');
    const product = await getProduct(creds, req.params.productId);
    res.json({ images: toMediaList(product.images) });
  }),
);

// Replace the gallery with an ordered list (reorder / set cover / remove / add-by-id-or-url).
const mediaPatchSchema = z
  .object({
    images: z
      .array(
        z.object({
          id: z.string().trim().max(40).optional(),
          src: z.string().trim().url().max(2000).optional(),
        }),
      )
      .max(30),
  })
  .refine((v) => v.images.every((i) => (i.id && i.id.length > 0) || (i.src && i.src.length > 0)), {
    message: 'هر تصویر باید شناسه یا نشانی داشته باشد.',
  });

merchantRouter.patch(
  '/sites/:siteId/products/:productId/media',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    const parsed = mediaPatchSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('فهرست تصاویر نامعتبر است.');
    const creds = await getWooCredentials(site.id);
    if (!creds) throw badRequest('این فروشگاه اتصال REST فعال ندارد.');
    const product = await setProductImages(creds, req.params.productId, parsed.data.images);
    // Refresh the read-model so the gallery + cover reflect the real resulting state.
    try {
      await resyncProduct(site.id, req.params.productId);
    } catch {
      /* read-model refresh is best-effort; the WooCommerce write already succeeded */
    }
    await audit({
      actorUserId: req.auth!.sub,
      action: 'product.media.update',
      targetType: 'product',
      targetId: req.params.productId,
      requestIp: req.ip,
      meta: { siteId: site.id, count: parsed.data.images.length },
    });
    res.json({ images: toMediaList(product.images) });
  }),
);

// Upload an image binary (base64-in-JSON) to the store's media library; returns its id + URL.
// The route-level JSON limit is raised in app.ts for POST .../media only.
const mediaUploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().regex(/^image\/(jpe?g|png|webp|gif)$/i, 'نوع فایل پشتیبانی نمی‌شود.'),
  // base64 of the image bytes (~11MB max image after the 12mb JSON cap).
  dataBase64: z.string().min(8).max(15_000_000),
});

merchantRouter.post(
  '/sites/:siteId/media',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    const parsed = mediaUploadSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('فایل تصویر نامعتبر است.');
    const creds = await getWooCredentials(site.id);
    if (!creds) throw badRequest('این فروشگاه اتصال REST فعال ندارد.');
    const data = Buffer.from(parsed.data.dataBase64, 'base64');
    if (data.length === 0) throw badRequest('فایل تصویر خالی است.');
    const media = await uploadProductMedia(creds, {
      filename: parsed.data.filename,
      contentType: parsed.data.contentType,
      data,
    });
    await audit({
      actorUserId: req.auth!.sub,
      action: 'product.media.upload',
      targetType: 'site',
      targetId: site.id,
      requestIp: req.ip,
      meta: { mediaId: media.id, bytes: data.length },
    });
    res.status(201).json({ media });
  }),
);

const orderStatusSchema = z.object({
  status: z.enum([
    'pending',
    'processing',
    'on-hold',
    'completed',
    'cancelled',
    'refunded',
    'failed',
  ]),
});
merchantRouter.patch(
  '/sites/:siteId/orders/:orderId/status',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    ensureManage(req);
    const site = await siteFor(req, req.params.siteId);
    const parsed = orderStatusSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('وضعیت سفارش نامعتبر است.');
    const creds = await getWooCredentials(site.id);
    if (!creds) throw badRequest('این فروشگاه اتصال REST فعال ندارد.');
    const order = await updateOrderStatus(creds, req.params.orderId, parsed.data.status);
    await query(
      `UPDATE synced_order SET status = $3, updated_at = now() WHERE site_id = $1 AND external_id = $2`,
      [site.id, req.params.orderId, order.status],
    );
    await audit({
      actorUserId: req.auth!.sub,
      action: 'order.status.update',
      targetType: 'order',
      targetId: req.params.orderId,
      requestIp: req.ip,
      meta: { siteId: site.id, status: parsed.data.status },
    });
    res.json({ order });
  }),
);


// ---- support tickets (merchant side; admin side lives in admin.ts) ----

const ticketCreateSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  category: z.string().trim().max(40).optional(),
  siteId: z.string().trim().max(64).optional(),
});
const ticketReplySchema = z.object({ body: z.string().trim().min(1).max(5000) });

merchantRouter.post(
  '/support/tickets',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = await tenantFor(req);
    const parsed = ticketCreateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('موضوع و متن پیام را وارد کنید.');
    const created = await createSupportTicket({
      tenantId,
      siteId: parsed.data.siteId ?? null,
      userId: req.auth!.sub,
      subject: parsed.data.subject,
      category: parsed.data.category,
      body: parsed.data.body,
    });
    await audit({
      actorUserId: req.auth!.sub,
      action: 'support.ticket.create',
      targetType: 'support_ticket',
      targetId: created.ticket.id,
      requestIp: req.ip,
      meta: {},
    });
    res.status(201).json({ ticket: created.ticket, message: created.message });
  }),
);

merchantRouter.get(
  '/support/tickets',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = await tenantFor(req);
    const tickets = await listSupportTickets({ tenantId });
    res.json({ tickets });
  }),
);

merchantRouter.get(
  '/support/unread-count',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = await tenantFor(req);
    res.json({ count: await supportUnreadCount({ tenantId }) });
  }),
);

merchantRouter.get(
  '/support/tickets/:id',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = await tenantFor(req);
    const ticket = await getSupportTicket(req.params.id, { tenantId });
    const messages = await getSupportMessages(ticket.id);
    await markSupportRead(ticket.id, 'merchant', { tenantId }); // opening the thread clears unread
    res.json({ ticket: { ...ticket, merchant_unread: 0 }, messages });
  }),
);

merchantRouter.post(
  '/support/tickets/:id/messages',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = await tenantFor(req);
    const parsed = ticketReplySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('متن پیام را وارد کنید.');
    const message = await addSupportMessage(
      req.params.id,
      { senderRole: 'merchant', userId: req.auth!.sub, body: parsed.data.body },
      { tenantId },
    );
    res.status(201).json({ message });
  }),
);

// ---- Onboarding (managed store launch) ----

const referralSchema = z.object({ referralCode: z.string().trim().min(1).max(40) });

merchantRouter.post(
  '/onboarding/validate-referral',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = referralSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('کد معرف را وارد کنید.');
    const result = await validateReferralCode(parsed.data.referralCode);
    res.json({ ok: true, code: result.code });
  }),
);

const existingOnboardingSchema = z.object({
  referralCode: z.string().trim().min(1).max(40),
  businessName: z.string().trim().min(1).max(120),
  siteUrl: z.string().trim().url(),
  platform: z.string().trim().min(1),
  requestType: z.string().trim().min(1),
  contactNote: z.string().trim().max(2000).optional(),
});

const newOnboardingSchema = z.object({
  referralCode: z.string().trim().min(1).max(40),
  businessName: z.string().trim().min(1).max(120),
  domain: z.string().trim().min(3).max(200),
  businessType: z.string().trim().min(1),
  templateId: z.string().trim().min(1),
  planId: z.string().trim().min(1),
  brandAssets: z.array(z.object({ key: z.string(), readiness: z.string() })).optional(),
  brandColorPreference: z.string().trim().max(120).optional(),
  contactNote: z.string().trim().max(2000).optional(),
});

merchantRouter.get(
  '/onboarding/templates',
  asyncHandler(async (_req, res: Response) => {
    res.json({ items: [] });
  }),
);

merchantRouter.get(
  '/onboarding/plans',
  asyncHandler(async (_req, res: Response) => {
    const plans = await query(`SELECT id, code, name, price_minor, currency, interval, features FROM plan WHERE active = true`);
    res.json({ items: plans });
  }),
);

merchantRouter.get(
  '/onboarding/requests',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = await tenantFor(req);
    const rows = await listOnboardingRequestsForTenant(tenantId);
    res.json({ items: rows });
  }),
);

merchantRouter.get(
  '/onboarding/requests/:id',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = await tenantFor(req);
    const row = await getOnboardingRequestForTenant(tenantId, req.params.id);
    if (!row) throw notFound('درخواست یافت نشد.');
    const events = await listOnboardingStatusEvents(row.id);
    res.json({ request: row, statusHistory: events });
  }),
);

merchantRouter.post(
  '/onboarding/requests/existing',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = existingOnboardingSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('اطلاعات درخواست ناقص است.');
    const tenantId = await tenantFor(req);
    const created = await createOnboardingRequest({
      tenantId,
      userId: req.auth!.sub,
      type: 'existing',
      referralCode: parsed.data.referralCode,
      payload: parsed.data,
    });
    res.status(201).json({ request: created });
  }),
);

merchantRouter.post(
  '/onboarding/requests/new',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = newOnboardingSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('اطلاعات درخواست ناقص است.');
    const tenantId = await tenantFor(req);
    const created = await createOnboardingRequest({
      tenantId,
      userId: req.auth!.sub,
      type: 'new',
      referralCode: parsed.data.referralCode,
      payload: parsed.data,
    });
    res.status(201).json({ request: created });
  }),
);

merchantRouter.get(
  '/notifications',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const unreadOnly = req.query.unread === '1';
    const items = await listNotifications({
      audience: 'merchant',
      userId: req.auth!.sub,
      unreadOnly,
    });
    res.json({ items, unreadCount: await unreadNotificationCount('merchant', req.auth!.sub) });
  }),
);

merchantRouter.patch(
  '/notifications/:id/read',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    await markNotificationRead(req.params.id, req.auth!.sub);
    res.json({ ok: true });
  }),
);

const socialPlatformSchema = z.enum([
  'instagram',
  'telegram',
  'bale',
  'eitaa',
  'rubika',
  'whatsapp_business',
  'webhook',
  'website',
]);

merchantRouter.get(
  '/sites/:siteId/social/connections',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const items = await listSocialConnections(site.id);
    res.json({ items });
  }),
);

merchantRouter.post(
  '/sites/:siteId/social/connections',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const tenantId = await tenantFor(req);
    const parsed = z
      .object({
        platform: socialPlatformSchema,
        displayName: z.string().min(1),
        handleUrl: z.string().optional(),
        authType: z.string().min(1),
        token: z.string().optional(),
        autoPublishEnabled: z.boolean().optional(),
        captionTemplate: z.string().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest('اطلاعات کانال ناقص است.');
    const created = await createSocialConnection({
      tenantId,
      siteId: site.id,
      platform: parsed.data.platform as SocialPlatform,
      displayName: parsed.data.displayName,
      handleUrl: parsed.data.handleUrl,
      authType: parsed.data.authType,
      token: parsed.data.token,
      autoPublishEnabled: parsed.data.autoPublishEnabled,
      captionTemplate: parsed.data.captionTemplate,
      actorUserId: req.auth!.sub,
    });
    res.status(201).json({ connection: created });
  }),
);

merchantRouter.post(
  '/sites/:siteId/social/connections/:connectionId/test',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const result = await testSocialConnection(req.params.connectionId, site.id);
    res.json(result);
  }),
);

merchantRouter.delete(
  '/sites/:siteId/social/connections/:connectionId',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    await disconnectSocialConnection(req.params.connectionId, site.id, req.auth!.sub);
    res.json({ ok: true });
  }),
);

merchantRouter.get(
  '/sites/:siteId/social/publish-jobs',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const productId = req.query.productId ? String(req.query.productId) : undefined;
    const items = await listPublishJobs(site.id, productId);
    res.json({ items });
  }),
);

merchantRouter.post(
  '/sites/:siteId/social/publish-jobs',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const site = await siteFor(req, req.params.siteId);
    const tenantId = await tenantFor(req);
    const parsed = z
      .object({
        connectionId: z.string().uuid(),
        productExternalId: z.string().min(1),
        action: z.enum(['publish', 'update']).optional(),
        payload: z.object({
          productId: z.string(),
          name: z.string(),
          description: z.string().optional(),
          price: z.string(),
          currency: z.string(),
          permalink: z.string().optional(),
          imageUrls: z.array(z.string()),
        }),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest('اطلاعات انتشار ناقص است.');
    const job = await enqueueProductPublishJob({
      tenantId,
      siteId: site.id,
      connectionId: parsed.data.connectionId,
      productExternalId: parsed.data.productExternalId,
      payload: parsed.data.payload,
      action: parsed.data.action,
      actorUserId: req.auth!.sub,
    });
    res.status(201).json({ job });
  }),
);
