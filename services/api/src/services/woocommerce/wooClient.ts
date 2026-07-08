/**
 * WooCommerceClient — server-side WooCommerce REST client.
 *
 * The frontend NEVER calls WooCommerce and NEVER holds store keys. This client authenticates with
 * the store's consumer key/secret (decrypted from the vault per request), with a timeout, bounded
 * retries on transient errors, and response normalization to frontend-safe shapes (money as
 * integer minor units; PII minimized). Errors are wrapped so secrets never leak.
 */
import { env } from '../../env';
import { badGateway } from '../../util/errors';
import { assertSafeOutboundUrl, safeFetch } from '../../util/ssrf';
import { toMinorUnits } from '../money';

export interface WooCredentials {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface WooPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface NormalizedProductImage {
  externalId: string | null;
  src: string;
  alt: string | null;
  position: number;
}

export interface NormalizedProductCategoryRef {
  externalId: string;
  name: string | null;
}

export interface NormalizedProductRef {
  externalId: string;
  name: string | null;
  slug?: string | null;
}

export interface NormalizedProductAttribute {
  externalId: string | null;
  name: string;
  slug: string | null;
  options: string[];
  isVariation: boolean;
  isVisible: boolean;
  position: number;
  raw: Record<string, unknown>;
}

export interface NormalizedProduct {
  externalId: string;
  name: string;
  sku: string | null;
  status: string | null;
  type: string | null;
  permalink: string | null;
  priceMinor: number;
  regularPriceMinor: number;
  salePriceMinor: number | null;
  currency: string;
  stockStatus: string | null;
  stockQty: number | null;
  categories: NormalizedProductCategoryRef[];
  tags: NormalizedProductRef[];
  brands: NormalizedProductRef[];
  productAttributes: NormalizedProductAttribute[];
  images: NormalizedProductImage[];
  attributes: unknown;
  /** Full `meta_data`/postmeta — preserved losslessly (queryable JSONB), never shown raw in UI. */
  meta: unknown;
  /** Raw WooCommerce payload, preserved server-side for forward compatibility (never sent to UI). */
  raw: Record<string, unknown>;
}

export interface NormalizedCategory {
  externalId: string;
  parentExternalId: string | null;
  name: string;
  slug: string | null;
  raw: Record<string, unknown>;
}

/** Tag / brand taxonomy term (same shape). brands come from the optional product_brand taxonomy. */
export interface NormalizedTaxonomyTerm {
  externalId: string;
  name: string;
  slug: string | null;
  raw: Record<string, unknown>;
}

export interface NormalizedAttribute {
  externalId: string;
  name: string;
  slug: string | null;
  type: string | null;
  raw: Record<string, unknown>;
}

export interface NormalizedAttributeTerm {
  attributeExternalId: string;
  externalId: string;
  name: string;
  slug: string | null;
  raw: Record<string, unknown>;
}

export interface NormalizedVariation {
  externalId: string;
  sku: string | null;
  priceMinor: number;
  currency: string;
  stockStatus: string | null;
  stockQty: number | null;
  attributes: unknown;
  /** Full variation `meta_data` — preserved losslessly. */
  meta: unknown;
  raw: Record<string, unknown>;
}

export interface NormalizedOrderLineItem {
  externalId: string;
  productId: string;
  name: string;
  sku: string | null;
  quantity: number;
  priceMinor: number;
  totalMinor: number;
}

export interface NormalizedAddress {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  address1: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
}

export interface NormalizedOrder {
  externalId: string;
  number: string | null;
  status: string | null;
  totalMinor: number;
  subtotalMinor: number;
  taxMinor: number;
  shippingMinor: number;
  discountMinor: number;
  currency: string;
  customerName: string | null;
  paymentMethodTitle: string | null;
  lineItems: NormalizedOrderLineItem[];
  billing: NormalizedAddress;
  shipping: NormalizedAddress | null;
  createdAt: string | null;
}

export interface NormalizedCustomer {
  externalId: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  username: string | null;
  ordersCount: number;
  totalSpentMinor: number;
  currency: string;
  dateCreated: string | null;
}

export interface NormalizedCoupon {
  externalId: string;
  code: string | null;
  discountType: string | null;
  amountMinor: number;
  currency: string;
}

function authHeader(creds: WooCredentials): string {
  const basic = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64');
  return `Basic ${basic}`;
}

function baseUrl(storeUrl: string): string {
  return storeUrl.replace(/\/+$/, '');
}

/**
 * Defense-in-depth redaction: strip the consumer key/secret out of any string before it could be
 * surfaced in an error or a log. We never log full Woo URLs (which under query-auth carry the
 * secret), but this guarantees secrets can never leak even if some upstream error embeds them.
 */
function redactWooSecrets(text: string, creds: WooCredentials): string {
  let out = text;
  if (creds.consumerSecret) out = out.split(creds.consumerSecret).join('cs_***');
  if (creds.consumerKey) out = out.split(creds.consumerKey).join('ck_***');
  // Also redact any consumer_secret/consumer_key query params that slipped into a URL string.
  out = out.replace(/(consumer_(?:key|secret)=)[^&\s"']+/gi, '$1***');
  return out;
}

type WooMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type WooAuthStrategy = 'query' | 'basic';

interface WooHttpOptions {
  method?: WooMethod;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
}

/**
 * Central WooCommerce REST request builder — the single place all Woo calls go through so auth,
 * timeouts, retries and error mapping are consistent.
 *
 * Auth: over HTTPS we try QUERY-STRING auth first (`consumer_key`/`consumer_secret`), because many
 * managed WordPress hosts silently drop the `Authorization` header (PHP-CGI / proxies), which made
 * Basic-auth requests fail with `woocommerce_rest_cannot_view`. If query-auth is rejected (401/403)
 * we fall back to Basic auth. Over plain HTTP (local/dev only) we use Basic ONLY — secrets must
 * never be placed in a plaintext query string. SSRF validation runs on the host before any fetch.
 *
 * Errors are mapped to specific codes (never a generic timeout): `woo_auth_failed` (401),
 * `woo_forbidden` (403), `woo_timeout` (abort), `woo_network_error` (connection), `woo_unavailable`
 * (429/5xx), `woo_request_failed` (other). Secrets are redacted from any thrown message.
 */
async function wooHttp(
  creds: WooCredentials,
  path: string,
  opts: WooHttpOptions = {},
): Promise<{ json: unknown; total: number }> {
  const method: WooMethod = opts.method ?? 'GET';
  const root = baseUrl(creds.storeUrl);
  await assertSafeOutboundUrl(root); // SSRF guard on the host (unchanged by query params)
  const isHttps = /^https:\/\//i.test(root);

  const buildUrl = (withQueryAuth: boolean): URL => {
    const u = new URL(`${root}/wp-json/wc/v3${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    if (withQueryAuth) {
      u.searchParams.set('consumer_key', creds.consumerKey);
      u.searchParams.set('consumer_secret', creds.consumerSecret);
    }
    return u;
  };

  // Over HTTPS: query-auth first (robust against dropped Authorization), then Basic fallback.
  const strategies: WooAuthStrategy[] = isHttps ? ['query', 'basic'] : ['basic'];
  let sawForbidden = false;

  for (const strategy of strategies) {
    const url = buildUrl(strategy === 'query');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (strategy === 'basic') headers.Authorization = authHeader(creds);

    let authRejected = false;
    for (let attempt = 0; attempt <= env.WOO_MAX_RETRIES; attempt += 1) {
      try {
        const res = await safeFetch(url.href, {
          method,
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          timeoutMs: env.WOO_HTTP_TIMEOUT_MS,
        });
        if (res.status === 401 || res.status === 403) {
          if (res.status === 403) sawForbidden = true;
          authRejected = true; // do not retry auth failures; try the next strategy instead
          break;
        }
        if (res.status === 429 || res.status >= 500) {
          if (attempt < env.WOO_MAX_RETRIES) {
            await delay(250 * (attempt + 1));
            continue;
          }
          throw badGateway('فروشگاه ووکامرس پاسخ نداد.', 'woo_unavailable');
        }
        if (!res.ok) {
          throw badGateway('درخواست به ووکامرس ناموفق بود.', 'woo_request_failed');
        }
        const total = Number(res.headers.get('x-wp-total') ?? '0') || 0;
        const json = await res.json().catch(() => null);
        return { json, total };
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') {
          if (attempt < env.WOO_MAX_RETRIES) {
            await delay(250 * (attempt + 1));
            continue;
          }
          throw badGateway('اتصال به فروشگاه بیش از حد طول کشید.', 'woo_timeout');
        }
        if (isNetworkError(err)) {
          if (attempt < env.WOO_MAX_RETRIES) {
            await delay(250 * (attempt + 1));
            continue;
          }
          throw badGateway('فروشگاه در دسترس نیست یا ارتباط برقرار نشد.', 'woo_network_error');
        }
        // Already a safe AppError (no secrets); redact defensively and rethrow.
        if (err instanceof Error) err.message = redactWooSecrets(err.message, creds);
        throw err;
      }
    }
    if (!authRejected) break; // a non-auth terminal outcome already returned/threw
    // else: this strategy was rejected with 401/403 → try the next strategy
  }

  // Every auth strategy was rejected.
  if (sawForbidden) {
    throw badGateway('کلید واردشده دسترسی لازم برای این عملیات را ندارد.', 'woo_forbidden');
  }
  throw badGateway('اعتبارنامه ووکامرس معتبر نیست یا دسترسی کافی ندارد.', 'woo_auth_failed');
}

async function wooFetch(
  creds: WooCredentials,
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<{ json: unknown; total: number }> {
  return wooHttp(creds, path, { method: 'GET', query });
}

function isNetworkError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network/i.test(msg);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  stockStatus?: string;
}

function pageParams(q: ListQuery): { page: number; per_page: number } {
  const page = Math.max(1, q.page ?? 1);
  const per_page = Math.min(100, Math.max(1, q.pageSize ?? 20));
  return { page, per_page };
}

/** Verify credentials by reading store system status / a cheap endpoint. Returns store meta. */
export async function verifyWooCredentials(
  creds: WooCredentials,
): Promise<{ ok: true; currency: string; wooVersion: string | null }> {
  // Lightest possible auth proof: list ONE product. This endpoint is readable on virtually every
  // store whose REST keys have read access, returns instantly, and (unlike system_status) is not
  // restricted by hardening plugins — so a successful response reliably proves the keys work.
  await wooFetch(creds, '/products', { per_page: 1 });

  // Currency + Woo version are best-effort enrichment; never fail the connection if restricted.
  let currency = 'IRT';
  let wooVersion: string | null = null;
  try {
    const cur = await wooFetch(creds, '/data/currencies/current');
    currency = (cur.json as { code?: string })?.code ?? currency;
  } catch {
    /* /data/currencies/current may be restricted — auth already proven via /products */
  }
  try {
    const sys = await wooFetch(creds, '/system_status', {});
    wooVersion = ((sys.json as { environment?: { version?: string } })?.environment?.version) ?? null;
  } catch {
    /* system_status is often restricted; not required for a successful connection */
  }
  return { ok: true, currency, wooVersion };
}

export async function listProducts(
  creds: WooCredentials,
  q: ListQuery = {},
): Promise<WooPage<NormalizedProduct>> {
  const { page, per_page } = pageParams(q);
  const { json, total } = await wooFetch(creds, '/products', {
    page,
    per_page,
    search: q.search,
    status: q.status,
    stock_status: q.stockStatus,
  });
  const rows = Array.isArray(json) ? json : [];
  return {
    page,
    pageSize: per_page,
    total,
    items: rows.map((p) => normalizeProduct(p as Record<string, unknown>)),
  };
}

export async function getProduct(
  creds: WooCredentials,
  productId: string,
): Promise<NormalizedProduct> {
  const { json } = await wooFetch(creds, `/products/${encodeURIComponent(productId)}`);
  return normalizeProduct(json as Record<string, unknown>);
}

export async function listCategories(
  creds: WooCredentials,
  q: ListQuery = {},
): Promise<WooPage<NormalizedCategory>> {
  const { page, per_page } = pageParams(q);
  const { json, total } = await wooFetch(creds, '/products/categories', { page, per_page });
  const rows = Array.isArray(json) ? json : [];
  return {
    page,
    pageSize: per_page,
    total,
    items: rows.map((c) => normalizeCategory(c as Record<string, unknown>)),
  };
}

export async function listProductVariations(
  creds: WooCredentials,
  productId: string,
  q: ListQuery = {},
): Promise<WooPage<NormalizedVariation>> {
  const { page, per_page } = pageParams(q);
  const { json, total } = await wooFetch(
    creds,
    `/products/${encodeURIComponent(productId)}/variations`,
    { page, per_page },
  );
  const rows = Array.isArray(json) ? json : [];
  return {
    page,
    pageSize: per_page,
    total,
    items: rows.map((v) => normalizeVariation(v as Record<string, unknown>)),
  };
}

export async function listTags(
  creds: WooCredentials,
  q: ListQuery = {},
): Promise<WooPage<NormalizedTaxonomyTerm>> {
  const { page, per_page } = pageParams(q);
  const { json, total } = await wooFetch(creds, '/products/tags', { page, per_page });
  const rows = Array.isArray(json) ? json : [];
  return { page, pageSize: per_page, total, items: rows.map((t) => normalizeTaxonomyTerm(t as Record<string, unknown>)) };
}

/**
 * Brands come from the optional `product_brand` taxonomy (WooCommerce Brands / Woodmart / Perfect
 * Brands). The endpoint may not exist on a given store — callers treat a failure as "no brands".
 */
export async function listBrands(
  creds: WooCredentials,
  q: ListQuery = {},
): Promise<WooPage<NormalizedTaxonomyTerm>> {
  const { page, per_page } = pageParams(q);
  const { json, total } = await wooFetch(creds, '/products/brands', { page, per_page });
  const rows = Array.isArray(json) ? json : [];
  return { page, pageSize: per_page, total, items: rows.map((b) => normalizeTaxonomyTerm(b as Record<string, unknown>)) };
}

export async function listAttributes(creds: WooCredentials): Promise<NormalizedAttribute[]> {
  const { json } = await wooFetch(creds, '/products/attributes', { per_page: 100 });
  const rows = Array.isArray(json) ? json : [];
  return rows.map((a) => {
    const r = a as Record<string, unknown>;
    return {
      externalId: String(r.id ?? ''),
      name: String(r.name ?? ''),
      slug: (r.slug as string) || null,
      type: (r.type as string) || null,
      raw: r,
    };
  });
}

export async function listAttributeTerms(
  creds: WooCredentials,
  attributeExternalId: string,
  q: ListQuery = {},
): Promise<WooPage<NormalizedAttributeTerm>> {
  const { page, per_page } = pageParams(q);
  const { json, total } = await wooFetch(
    creds,
    `/products/attributes/${encodeURIComponent(attributeExternalId)}/terms`,
    { page, per_page },
  );
  const rows = Array.isArray(json) ? json : [];
  return {
    page,
    pageSize: per_page,
    total,
    items: rows.map((t) => {
      const r = t as Record<string, unknown>;
      return {
        attributeExternalId,
        externalId: String(r.id ?? ''),
        name: String(r.name ?? ''),
        slug: (r.slug as string) || null,
        raw: r,
      };
    }),
  };
}

export async function listOrders(
  creds: WooCredentials,
  q: ListQuery = {},
): Promise<WooPage<NormalizedOrder>> {
  const { page, per_page } = pageParams(q);
  const { json, total } = await wooFetch(creds, '/orders', {
    page,
    per_page,
    status: q.status,
    search: q.search,
  });
  const rows = Array.isArray(json) ? json : [];
  return {
    page,
    pageSize: per_page,
    total,
    items: rows.map((o) => normalizeOrder(o as Record<string, unknown>)),
  };
}

export async function getOrder(creds: WooCredentials, orderId: string): Promise<NormalizedOrder> {
  const { json } = await wooFetch(creds, `/orders/${encodeURIComponent(orderId)}`);
  return normalizeOrder(json as Record<string, unknown>);
}

export async function listCustomers(
  creds: WooCredentials,
  q: ListQuery = {},
): Promise<WooPage<NormalizedCustomer>> {
  const { page, per_page } = pageParams(q);
  const { json, total } = await wooFetch(creds, '/customers', { page, per_page, search: q.search });
  const rows = Array.isArray(json) ? json : [];
  return {
    page,
    pageSize: per_page,
    total,
    items: rows.map((c) => normalizeCustomer(c as Record<string, unknown>)),
  };
}

export async function listCoupons(
  creds: WooCredentials,
  q: ListQuery = {},
): Promise<WooPage<NormalizedCoupon>> {
  const { page, per_page } = pageParams(q);
  const { json, total } = await wooFetch(creds, '/coupons', { page, per_page });
  const rows = Array.isArray(json) ? json : [];
  return {
    page,
    pageSize: per_page,
    total,
    items: rows.map((c) => normalizeCoupon(c as Record<string, unknown>)),
  };
}

export interface SalesReport {
  totalSalesMinor: number;
  netSalesMinor: number;
  totalOrders: number;
  totalItems: number;
  currency: string;
  period: string;
}

export async function getSalesReport(
  creds: WooCredentials,
  period: 'week' | 'month' | 'year' = 'week',
): Promise<SalesReport> {
  const { json } = await wooFetch(creds, '/reports/sales', { period });
  const row = Array.isArray(json) ? (json[0] as Record<string, unknown>) : {};
  const currency = 'IRT';
  return {
    period,
    currency,
    totalSalesMinor: toMinorUnits(String(row?.total_sales ?? '0'), currency),
    netSalesMinor: toMinorUnits(String(row?.net_sales ?? '0'), currency),
    totalOrders: Number(row?.total_orders ?? 0),
    totalItems: Number(row?.total_items ?? 0),
  };
}

// ---- write operations (controlled; require manage permission upstream) ----

export async function updateProductStock(
  creds: WooCredentials,
  productId: string,
  stockQuantity: number,
): Promise<NormalizedProduct> {
  const { json } = await wooPut(creds, `/products/${encodeURIComponent(productId)}`, {
    stock_quantity: stockQuantity,
    manage_stock: true,
  });
  return normalizeProduct(json as Record<string, unknown>);
}

export async function updateOrderStatus(
  creds: WooCredentials,
  orderId: string,
  status: string,
): Promise<NormalizedOrder> {
  const { json } = await wooPut(creds, `/orders/${encodeURIComponent(orderId)}`, { status });
  return normalizeOrder(json as Record<string, unknown>);
}

export interface ProductUpdateInput {
  name?: string;
  /** Major-unit price string (e.g. "120000"); WooCommerce stores prices as strings. */
  regularPrice?: string;
  /** Major-unit sale price string. Empty string clears the sale. */
  salePrice?: string;
  status?: string;
  manageStock?: boolean;
  stockQuantity?: number;
  stockStatus?: string;
  /** WooCommerce category external ids to assign. */
  categoryExternalIds?: ReadonlyArray<string>;
  /**
   * Images by EXISTING WooCommerce media id or already-hosted URL. No binary upload is performed
   * here — that is the only safe write path until a media-upload backend exists.
   */
  images?: ReadonlyArray<{ id?: string; src?: string }>;
}

/** Update a WooCommerce product (controlled fields only; requires manage permission upstream). */
export async function updateProduct(
  creds: WooCredentials,
  productId: string,
  input: ProductUpdateInput,
): Promise<NormalizedProduct> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.regularPrice !== undefined) body.regular_price = input.regularPrice;
  if (input.salePrice !== undefined) body.sale_price = input.salePrice;
  if (input.status !== undefined) body.status = input.status;
  if (input.manageStock !== undefined) body.manage_stock = input.manageStock;
  if (input.stockQuantity !== undefined) body.stock_quantity = input.stockQuantity;
  if (input.stockStatus !== undefined) body.stock_status = input.stockStatus;
  if (input.categoryExternalIds !== undefined) {
    body.categories = input.categoryExternalIds.map((id) => ({ id: Number(id) || id }));
  }
  if (input.images !== undefined) {
    body.images = input.images.map((img) =>
      img.id !== undefined ? { id: Number(img.id) || img.id } : { src: img.src },
    );
  }
  const { json } = await wooPut(creds, `/products/${encodeURIComponent(productId)}`, body);
  return normalizeProduct(json as Record<string, unknown>);
}

export interface ProductCreateInput {
  name: string;
  sku?: string;
  /** Major-unit price string (e.g. "120000"). */
  regularPrice?: string;
  /** WooCommerce publication status. The created product is REALLY in this status. */
  status?: string;
  manageStock?: boolean;
  stockQuantity?: number;
  description?: string;
}

/**
 * Create a WooCommerce product and return its REAL resulting state (status, id, …). The caller
 * reports the truthful status — "publish" really publishes; "draft" really stays a draft. No
 * binary image upload is performed (images are added in WordPress), so no fake media is attached.
 */
export async function createProduct(
  creds: WooCredentials,
  input: ProductCreateInput,
): Promise<NormalizedProduct> {
  const body: Record<string, unknown> = { name: input.name, type: 'simple' };
  if (input.sku !== undefined && input.sku !== '') body.sku = input.sku;
  if (input.regularPrice !== undefined && input.regularPrice !== '') {
    body.regular_price = input.regularPrice;
  }
  if (input.status !== undefined) body.status = input.status;
  if (input.description !== undefined && input.description !== '') {
    body.description = input.description;
  }
  if (input.stockQuantity !== undefined) {
    body.manage_stock = input.manageStock ?? true;
    body.stock_quantity = input.stockQuantity;
  }
  const { json } = await wooPost(creds, `/products`, body);
  return normalizeProduct(json as Record<string, unknown>);
}

/**
 * Delete a WooCommerce product. Defaults to TRASH (soft delete) so it can be restored from
 * WordPress; pass `force=true` only on an explicit, confirmed hard delete. Returns the deleted
 * product's external id. Goes through the central request builder (auth fallback + error mapping).
 */
export async function deleteProduct(
  creds: WooCredentials,
  productExternalId: string,
  force = false,
): Promise<{ externalId: string }> {
  const { json } = await wooHttp(creds, `/products/${encodeURIComponent(productExternalId)}`, {
    method: 'DELETE',
    query: { force: force ? 'true' : 'false' },
  });
  const id = (json as { id?: number | string })?.id;
  return { externalId: id !== undefined ? String(id) : productExternalId };
}

/**
 * Replace a product's image gallery with the given ordered list (first image = cover/featured).
 * Each entry is an EXISTING WordPress media id, or a publicly-reachable URL that Woo will sideload.
 * Used for reorder / set-cover / remove / add-by-existing-media. Returns the updated product.
 */
export async function setProductImages(
  creds: WooCredentials,
  productId: string,
  images: ReadonlyArray<{ id?: string; src?: string }>,
): Promise<NormalizedProduct> {
  return updateProduct(creds, productId, { images });
}

export interface UploadedMedia {
  id: string;
  src: string;
  alt: string | null;
}

/**
 * Upload an image binary to the store's WordPress media library (`/wp-json/wp/v2/media`) and
 * return the created attachment. Uses the same Woo credentials (query-auth over HTTPS, Basic
 * fallback), the SSRF guard, and secret redaction. NOTE: WooCommerce consumer keys authenticate
 * the `wc/v3` namespace; some stores also accept them (or an Application Password configured as the
 * key/secret) for WP core REST, some do not. When the store rejects the upload we throw a
 * TRUTHFUL, actionable `woo_media_unsupported` error (the caller offers the add-by-URL path) —
 * never a fake success and never a "go to WordPress" instruction.
 */
export async function uploadProductMedia(
  creds: WooCredentials,
  file: { filename: string; contentType: string; data: Buffer },
): Promise<UploadedMedia> {
  const root = baseUrl(creds.storeUrl);
  await assertSafeOutboundUrl(root);
  const isHttps = /^https:\/\//i.test(root);
  const safeName = (file.filename.replace(/[^\w.\-]/g, '_').slice(0, 120) || 'upload') as string;
  const strategies: WooAuthStrategy[] = isHttps ? ['query', 'basic'] : ['basic'];

  for (const strategy of strategies) {
    const u = new URL(`${root}/wp-json/wp/v2/media`);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': file.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeName}"`,
    };
    if (strategy === 'query') {
      u.searchParams.set('consumer_key', creds.consumerKey);
      u.searchParams.set('consumer_secret', creds.consumerSecret);
    } else {
      headers.Authorization = authHeader(creds);
    }
    try {
      const res = await safeFetch(u.href, {
        method: 'POST',
        headers,
        body: file.data,
        timeoutMs: env.WOO_HTTP_TIMEOUT_MS,
      });
      if (res.status === 401 || res.status === 403) {
        continue; // try the next auth strategy, else fall through to the truthful error below
      }
      if (!res.ok) {
        throw badGateway('بارگذاری رسانه در فروشگاه ناموفق بود.', 'woo_media_failed');
      }
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const id = json?.id;
      const src = (json?.source_url as string) ?? '';
      if (id === undefined || id === null || !src) {
        throw badGateway('پاسخ نامعتبر از کتابخانه رسانه فروشگاه.', 'woo_media_failed');
      }
      return { id: String(id), src, alt: (json?.alt_text as string) || null };
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw badGateway('بارگذاری رسانه بیش از حد طول کشید.', 'woo_timeout');
      }
      if (isNetworkError(err)) {
        throw badGateway('فروشگاه در دسترس نیست یا ارتباط برقرار نشد.', 'woo_network_error');
      }
      if (err instanceof Error) err.message = redactWooSecrets(err.message, creds);
      throw err;
    }
  }

  // The WP media endpoint rejected the Woo keys → truthful, actionable error (no WordPress redirect).
  throw badGateway(
    'کلیدهای فعلی اجازه بارگذاری رسانه را ندارند. می‌توانید نشانی (URL) تصویر را اضافه کنید یا برای بارگذاری مستقیم، افزونه JetWeb را به فروشگاه متصل کنید.',
    'woo_media_unsupported',
  );
}

async function wooPut(
  creds: WooCredentials,
  path: string,
  body: Record<string, unknown>,
): Promise<{ json: unknown }> {
  return wooWrite(creds, 'PUT', path, body);
}

async function wooPost(
  creds: WooCredentials,
  path: string,
  body: Record<string, unknown>,
): Promise<{ json: unknown }> {
  return wooWrite(creds, 'POST', path, body);
}

async function wooWrite(
  creds: WooCredentials,
  method: 'PUT' | 'POST',
  path: string,
  body: Record<string, unknown>,
): Promise<{ json: unknown }> {
  const { json } = await wooHttp(creds, path, { method, body });
  return { json };
}

// ---- normalizers ----

function normalizeProduct(p: Record<string, unknown>): NormalizedProduct {
  const currency = 'IRT';
  const rawCategories = Array.isArray(p.categories) ? (p.categories as Record<string, unknown>[]) : [];
  const rawTags = Array.isArray(p.tags) ? (p.tags as Record<string, unknown>[]) : [];
  const rawBrands = Array.isArray(p.brands) ? (p.brands as Record<string, unknown>[]) : [];
  const rawImages = Array.isArray(p.images) ? (p.images as Record<string, unknown>[]) : [];
  const rawAttributes = Array.isArray(p.attributes) ? (p.attributes as Record<string, unknown>[]) : [];
  const ref = (c: Record<string, unknown>): NormalizedProductRef => ({
    externalId: String(c.id ?? ''),
    name: (c.name as string) || null,
    slug: (c.slug as string) || null,
  });
  const sale = String(p.sale_price ?? '');
  return {
    externalId: String(p.id ?? ''),
    name: String(p.name ?? ''),
    sku: (p.sku as string) || null,
    status: (p.status as string) || null,
    type: (p.type as string) || null,
    permalink: (p.permalink as string) || null,
    priceMinor: toMinorUnits(String(p.price ?? '0'), currency),
    regularPriceMinor: toMinorUnits(String(p.regular_price ?? p.price ?? '0'), currency),
    salePriceMinor: sale ? toMinorUnits(sale, currency) : null,
    currency,
    stockStatus: (p.stock_status as string) || null,
    stockQty: p.stock_quantity === null || p.stock_quantity === undefined ? null : Number(p.stock_quantity),
    categories: rawCategories.map((c) => ({ externalId: String(c.id ?? ''), name: (c.name as string) || null })),
    tags: rawTags.map(ref),
    brands: rawBrands.map(ref),
    productAttributes: rawAttributes.map((a, i) => ({
      externalId: a.id === undefined || a.id === null || Number(a.id) === 0 ? null : String(a.id),
      name: String(a.name ?? ''),
      slug: (a.slug as string) || null,
      options: Array.isArray(a.options) ? (a.options as unknown[]).map((o) => String(o)) : [],
      isVariation: Boolean(a.variation),
      isVisible: a.visible === undefined ? true : Boolean(a.visible),
      position: typeof a.position === 'number' ? (a.position as number) : i,
      raw: a,
    })),
    images: rawImages.map((img, i) => ({
      externalId: img.id === undefined || img.id === null ? null : String(img.id),
      src: String(img.src ?? ''),
      alt: (img.alt as string) || null,
      position: typeof img.position === 'number' ? (img.position as number) : i,
    })).filter((img) => img.src.length > 0),
    attributes: p.attributes ?? null,
    meta: p.meta_data ?? null,
    raw: p,
  };
}

function normalizeCategory(c: Record<string, unknown>): NormalizedCategory {
  const parent = c.parent === undefined || c.parent === null || Number(c.parent) === 0
    ? null
    : String(c.parent);
  return {
    externalId: String(c.id ?? ''),
    parentExternalId: parent,
    name: String(c.name ?? ''),
    slug: (c.slug as string) || null,
    raw: c,
  };
}

function normalizeTaxonomyTerm(c: Record<string, unknown>): NormalizedTaxonomyTerm {
  return {
    externalId: String(c.id ?? ''),
    name: String(c.name ?? ''),
    slug: (c.slug as string) || null,
    raw: c,
  };
}

function normalizeVariation(v: Record<string, unknown>): NormalizedVariation {
  const currency = 'IRT';
  return {
    externalId: String(v.id ?? ''),
    sku: (v.sku as string) || null,
    priceMinor: toMinorUnits(String(v.price ?? '0'), currency),
    currency,
    stockStatus: (v.stock_status as string) || null,
    stockQty: v.stock_quantity === null || v.stock_quantity === undefined ? null : Number(v.stock_quantity),
    attributes: v.attributes ?? null,
    meta: v.meta_data ?? null,
    raw: v,
  };
}

function normalizeAddress(raw: Record<string, unknown> | undefined): NormalizedAddress {
  const b = raw ?? {};
  return {
    firstName: String(b.first_name ?? ''),
    lastName: String(b.last_name ?? ''),
    email: String(b.email ?? ''),
    phone: (b.phone as string) || null,
    address1: (b.address_1 as string) || null,
    city: (b.city as string) || null,
    postcode: (b.postcode as string) || null,
    country: (b.country as string) || null,
  };
}

function normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
  const currency = (o.currency as string) || 'IRT';
  const billing = normalizeAddress((o.billing as Record<string, unknown>) ?? {});
  const shippingRaw = (o.shipping as Record<string, unknown>) ?? {};
  const hasShipping = Object.values(shippingRaw).some((v) => v !== '' && v != null);
  const name = `${billing.firstName} ${billing.lastName}`.trim();
  const lineItemsRaw = Array.isArray(o.line_items) ? o.line_items : [];
  const lineItems: NormalizedOrderLineItem[] = lineItemsRaw.map((li) => {
    const row = li as Record<string, unknown>;
    return {
      externalId: String(row.id ?? ''),
      productId: String(row.product_id ?? ''),
      name: String(row.name ?? ''),
      sku: (row.sku as string) || null,
      quantity: Number(row.quantity ?? 0),
      priceMinor: toMinorUnits(String(row.price ?? '0'), currency),
      totalMinor: toMinorUnits(String(row.total ?? '0'), currency),
    };
  });
  return {
    externalId: String(o.id ?? ''),
    number: (o.number as string) || String(o.id ?? ''),
    status: (o.status as string) || null,
    totalMinor: toMinorUnits(String(o.total ?? '0'), currency),
    subtotalMinor: toMinorUnits(String(o.subtotal ?? o.total ?? '0'), currency),
    taxMinor: toMinorUnits(String(o.total_tax ?? '0'), currency),
    shippingMinor: toMinorUnits(String(o.shipping_total ?? '0'), currency),
    discountMinor: toMinorUnits(String(o.discount_total ?? '0'), currency),
    currency,
    customerName: name || null,
    paymentMethodTitle: (o.payment_method_title as string) || (o.payment_method as string) || null,
    lineItems,
    billing,
    shipping: hasShipping ? normalizeAddress(shippingRaw) : null,
    createdAt: (o.date_created_gmt as string) || (o.date_created as string) || null,
  };
}

function normalizeCustomer(c: Record<string, unknown>): NormalizedCustomer {
  const currency = 'IRT';
  const first = (c.first_name as string) ?? '';
  const last = (c.last_name as string) ?? '';
  const username = (c.username as string) ?? '';
  const display = `${first} ${last}`.trim() || username || null;
  return {
    externalId: String(c.id ?? ''),
    displayName: display,
    email: (c.email as string) || null,
    phone: (c.billing as Record<string, unknown> | undefined)?.phone as string | null ?? null,
    username: username || null,
    ordersCount: Number(c.orders_count ?? 0),
    totalSpentMinor: toMinorUnits(String(c.total_spent ?? '0'), currency),
    currency,
    dateCreated: (c.date_created_gmt as string) || (c.date_created as string) || null,
  };
}

function normalizeCoupon(c: Record<string, unknown>): NormalizedCoupon {
  const currency = 'IRT';
  return {
    externalId: String(c.id ?? ''),
    code: (c.code as string) || null,
    discountType: (c.discount_type as string) || null,
    amountMinor: toMinorUnits(String(c.amount ?? '0'), currency),
    currency,
  };
}
