/**
 * Mock Dashboard adapter — serves the operating-home overview from in-memory data.
 */
import { dashboardOverview } from '@/mock/data/dashboard';
import type { DashboardOverview } from '@/domain/types';

import type { DashboardAdapter } from '../types';
import { clone, delay } from './mockUtils';

export function createMockDashboardAdapter(): DashboardAdapter {
  return {
    async getOverview(_siteId?: string): Promise<DashboardOverview> {
      await delay(400);
      return clone(dashboardOverview);
    },
  };
}
