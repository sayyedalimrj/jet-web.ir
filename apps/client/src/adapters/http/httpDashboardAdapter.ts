/**
 * HTTP Dashboard adapter — assembles the operating-home overview for the active site from the
 * backend's site overview + recent orders + product read-model. Fields the backend does not
 * track (action items, activity feed, abandoned carts) are returned empty rather than faked.
 */
import { http, qs } from '@/services/httpClient';
import { minorToMoney } from '@/domain/money';
import type { DashboardOverview, Order, OrderStatus, Product } from '@/domain/types';

import type { DashboardAdapter } from '../types';
import { getActiveHttpSiteId } from './httpActiveSite';

interface SiteOverview {
  products: number;
  orders: number;
  customers: number;
  coupons: number;
  completed_revenue_minor: number | string;
}

export function createHttpDashboardAdapter(): DashboardAdapter {
  return {
    async getOverview(siteId?: string): Promise<DashboardOverview> {
      const id = siteId ?? getActiveHttpSiteId();
      if (!id) throw new Error('هیچ فروشگاهی انتخاب نشده است.');

      const [overviewRes, ordersRes, productsRes] = await Promise.all([
        http.get<{ site: { currency: string }; overview: SiteOverview }>(
          `/merchant/sites/${id}/overview`,
        ),
        http.get<{ items: BackendOrder[] }>(`/merchant/sites/${id}/orders${qs({ pageSize: 10 })}`),
        http.get<{ items: BackendProduct[] }>(
          `/merchant/sites/${id}/products${qs({ pageSize: 50 })}`,
        ),
      ]);

      const currency = overviewRes.site.currency;
      const o = overviewRes.overview;
      const products = productsRes.items.map((p) => toProduct(p, currency));
      const recentOrders = ordersRes.items.map((row) => toOrder(row, currency));

      const lowStock = products.filter(
        (p) => p.manageStock && (p.stockQuantity ?? 0) > 0 && (p.stockQuantity ?? 0) <= 5,
      );
      const outOfStock = products.filter((p) => p.stockStatus === 'outofstock');

      const now = new Date();
      const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      return {
        period: { from, to: now.toISOString() },
        currency,
        salesTotal: minorToMoney(o.completed_revenue_minor, currency),
        ordersCount: o.orders,
        productsCount: o.products,
        customersCount: o.customers,
        lowStockCount: lowStock.length,
        outOfStockCount: outOfStock.length,
        fulfillment: {
          unfulfilled: recentOrders.filter((r) => r.fulfillment === 'unfulfilled').length,
          partial: recentOrders.filter((r) => r.fulfillment === 'partial').length,
          fulfilled: recentOrders.filter((r) => r.fulfillment === 'fulfilled').length,
        },
        actionItems: [],
        inventoryAlerts: [...outOfStock, ...lowStock].slice(0, 10),
        recentOrders,
        topProducts: [],
        activity: [],
      };
    },
  };
}

interface BackendProduct {
  external_id: string;
  name: string;
  sku: string | null;
  status: string | null;
  price_minor: number | string;
  currency: string;
  stock_status: string | null;
  stock_qty: number | null;
}

interface BackendOrder {
  external_id: string;
  number: string | null;
  status: string | null;
  total_minor: number | string;
  currency: string;
  customer_name: string | null;
  external_created_at: string | null;
}

function toProduct(p: BackendProduct, currency: string): Product {
  const money = minorToMoney(p.price_minor, currency);
  const now = new Date().toISOString();
  return {
    id: p.external_id,
    name: p.name,
    slug: p.sku ?? p.external_id,
    sku: p.sku ?? '',
    type: 'simple',
    status: 'publish',
    price: money,
    regularPrice: money,
    currency,
    stockStatus: p.stock_status === 'outofstock' ? 'outofstock' : 'instock',
    stockQuantity: p.stock_qty ?? undefined,
    manageStock: p.stock_qty !== null && p.stock_qty !== undefined,
    categories: [],
    images: [],
    dateCreated: now,
    dateModified: now,
  };
}

function toOrder(o: BackendOrder, currency: string): Order {
  const valid: OrderStatus[] = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'];
  const status: OrderStatus = valid.includes(o.status as OrderStatus) ? (o.status as OrderStatus) : 'pending';
  const total = minorToMoney(o.total_minor, currency);
  const zero = minorToMoney(0, currency);
  const created = o.external_created_at ?? new Date().toISOString();
  return {
    id: o.external_id,
    number: o.number ?? o.external_id,
    status,
    fulfillment: status === 'completed' ? 'fulfilled' : status === 'processing' ? 'partial' : 'unfulfilled',
    currency,
    total,
    subtotal: total,
    totalTax: zero,
    shippingTotal: zero,
    discountTotal: zero,
    billing: { firstName: o.customer_name ?? '', lastName: '', email: '' },
    lineItems: [],
    paymentMethodTitle: '',
    statusHistory: [{ status, date: created }],
    dateCreated: created,
    dateModified: created,
  };
}
