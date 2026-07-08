/**
 * Dashboard service — thin wrapper over the active DashboardAdapter.
 */
import { getAdapters } from '@/adapters';
import { isApiConfigured } from '@/config/api.config';
import { http } from '@/services/httpClient';
import type { DashboardOverview } from '@/domain/types';

import { getActiveHttpSiteId } from '@/adapters/http/httpActiveSite';

export interface OverviewSeriesResponse {
  range: string;
  currency: string;
  sales: { day: string; orders: number; revenue_minor: number | string }[];
  customers: { day: string; new_customers: number }[];
}

export const dashboardService = {
  getOverview(siteId?: string): Promise<DashboardOverview> {
    return getAdapters().dashboard.getOverview(siteId);
  },

  async getOverviewSeries(
    range: '7d' | '30d' | '90d' = '7d',
    siteId?: string,
  ): Promise<OverviewSeriesResponse | null> {
    if (!isApiConfigured()) return null;
    const id = siteId ?? getActiveHttpSiteId();
    if (!id) return null;
    return http.get<OverviewSeriesResponse>(
      `/merchant/sites/${id}/reports/overview-series?range=${range}`,
    );
  },
};
