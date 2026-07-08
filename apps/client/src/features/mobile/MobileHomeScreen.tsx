/**
 * MobileHomeScreen — the customer-facing mobile home.
 *
 * A calm, mobile-first home: a dark hero site card (single, multi-site carousel, or an
 * onboarding card when there is no site), four quick actions, a "more features" entry, an
 * at-a-glance overview chart, and a short recent-activity list. The persistent top app bar
 * (profile, store name, theme, notifications, support) is provided globally by the AppShell.
 *
 * Switching the store in the carousel sets the ACTIVE store, so the whole dashboard — the
 * overview numbers here and the products/orders/customers screens — updates to that store.
 */
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';

import { EmptyState, LoadingState, Text } from '@/components/ui';
import { isApiConfigured } from '@/config/api.config';
import { triggerSiteSync, wooConnectErrorMessage } from '@/services/connectionApi';
import { dashboardService } from '@/services';
import { currencyExponent } from '@/domain/money';
import { useT } from '@/i18n/I18nProvider';
import { useFormatters } from '@/i18n/useFormatters';
import { useActiveSite, useSites } from '@/features/site/useSites';
import { useSetActiveSite } from '@/features/site/useSiteMutations';
import {
  isPendingOnboardingRequest,
  onboardingToPendingCard,
} from '@/features/onboarding/pendingSiteHelpers';
import { useOnboardingRequests } from '@/features/onboarding/useOnboarding';
import { useTheme } from '@/theme';
import type { DashboardOverview, SiteConnection } from '@/domain/types';

import {
  AnimatedSection,
  EmptySiteCard,
  FilterChipRow,
  MiniActivityRow,
  MobilePage,
  OverviewChart,
  PressableScale,
  QuickActionCard,
  SiteCarousel,
  type OverviewPoint,
} from './components';
import {
  buildOverviewSeries,
  OVERVIEW_METRICS,
  OVERVIEW_RANGES,
  QUICK_ACTIONS,
  quickActionCountsForSite,
  RECENT_ACTIVITY,
  SITE_RENEWAL_KEYS,
  type OverviewMetric,
  type OverviewRange,
} from './mobileMockData';
import { mobileMetrics, useMobileColors, useMobileShadow, useMobileType } from './mobileTokens';

function SectionTitle({ title }: { title: string }): React.JSX.Element {
  const colors = useMobileColors();
  const type = useMobileType();
  const { isRTL } = useTheme();
  return (
    <Text
      style={{
        fontSize: type.sectionSize,
        fontWeight: '700',
        color: colors.text,
        textAlign: isRTL ? 'right' : 'left',
        marginBottom: 12,
      }}
    >
      {title}
    </Text>
  );
}

function MoreEntryCard({ onPress }: { onPress: () => void }): React.JSX.Element {
  const colors = useMobileColors();
  const shadow = useMobileShadow();
  const type = useMobileType();
  const t = useT();
  const { rowDirection, isRTL } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={t('home.more.title')}
      testID="home-more-entry"
      style={[
        {
          flexDirection: rowDirection,
          alignItems: 'center',
          gap: 14,
          borderRadius: mobileMetrics.cardRadius,
          backgroundColor: colors.card,
          padding: 16,
        },
        shadow,
      ]}
    >
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          backgroundColor: colors.tile,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name="apps-outline" size={22} color={colors.primary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          style={{
            fontSize: type.labelSize,
            fontWeight: '700',
            color: colors.text,
            textAlign: isRTL ? 'right' : 'left',
          }}
        >
          {t('home.more.title')}
        </Text>
        <Text
          style={{
            fontSize: type.captionSize,
            color: colors.textSecondary,
            textAlign: isRTL ? 'right' : 'left',
          }}
          // Allow wrapping so the subtitle is fully visible (no clipped "…").
          numberOfLines={2}
        >
          {t('home.more.subtitle')}
        </Text>
      </View>
      <View
        style={{
          flexDirection: rowDirection,
          alignItems: 'center',
          gap: 4,
          paddingHorizontal: 12,
          height: 36,
          borderRadius: 9,
          backgroundColor: colors.tile,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: '700', color: colors.primary }}>
          {t('home.more.cta')}
        </Text>
        <Ionicons
          name={isRTL ? 'chevron-back' : 'chevron-forward'}
          size={15}
          color={colors.primary}
        />
      </View>
    </PressableScale>
  );
}

/** "At a glance" overview card: a metric + range selector over a calm bar chart. */
function OverviewSection({
  currency,
  siteId,
  showcase,
  overview,
}: {
  currency: string;
  siteId?: string;
  /** Showcase (mock) build renders illustrative trends; production never shows fake data. */
  showcase: boolean;
  /** Real, synced overview for production (when available). */
  overview?: DashboardOverview;
}): React.JSX.Element {
  const colors = useMobileColors();
  const shadow = useMobileShadow();
  const type = useMobileType();
  const t = useT();
  const fmt = useFormatters();
  const { rowDirection, isRTL } = useTheme();
  const [metric, setMetric] = useState<OverviewMetric>('sales');
  const [range, setRange] = useState<OverviewRange>('week');
  const queryClient = useQueryClient();
  const [syncNote, setSyncNote] = useState<string | undefined>();
  const rangeKey = range === 'week' ? '7d' : range === 'year' ? '90d' : '30d';
  const seriesQuery = useQuery({
    queryKey: ['site', siteId, 'overview-series', rangeKey, metric],
    queryFn: () => dashboardService.getOverviewSeries(rangeKey as '7d' | '30d' | '90d', siteId),
    enabled: !showcase && Boolean(siteId),
  });
  const sync = useMutation({
    mutationFn: () => triggerSiteSync(siteId as string),
    onSuccess: async () => {
      setSyncNote(t('home.overview.syncStarted'));
      if (siteId) {
        await queryClient.invalidateQueries({ queryKey: ['site', siteId, 'dashboard'] });
        await queryClient.invalidateQueries({ queryKey: ['site', siteId, 'overview-series'] });
        await queryClient.invalidateQueries({ queryKey: ['dashboard', 'overview', siteId] });
      }
    },
    onError: (e: unknown) => setSyncNote(wooConnectErrorMessage(e)),
  });

  // Production (real backend): show real headline totals, and a clean empty state for the trend
  // chart until a real time-series is synced. Never render mock bars/trend in production.
  if (!showcase) {
    const realTotal =
      metric === 'sales'
        ? fmt.money(overview?.salesTotal ?? '0', overview?.currency ?? currency)
        : metric === 'orders'
          ? fmt.num(overview?.ordersCount ?? 0)
          : fmt.num(overview?.customersCount ?? 0);

    const chartCurrency = seriesQuery.data?.currency ?? overview?.currency ?? currency;
    const revenueDivisor = 10 ** currencyExponent(chartCurrency);

    const salesRows = seriesQuery.data?.sales ?? [];
    const customerRows = seriesQuery.data?.customers ?? [];
    const chartSource =
      metric === 'customers'
        ? customerRows.map((r) => ({ label: String(r.day).slice(5, 10), value: Number(r.new_customers) }))
        : metric === 'orders'
          ? salesRows.map((r) => ({ label: String(r.day).slice(5, 10), value: Number(r.orders) }))
          : salesRows.map((r) => ({
              label: String(r.day).slice(5, 10),
              value: Number(r.revenue_minor) / revenueDivisor,
            }));

    const hasChart = seriesQuery.isSuccess && chartSource.some((row) => row.value > 0);
    const points: OverviewPoint[] = chartSource.map((row, index) => ({
      label: row.label,
      value: row.value,
      highlight: index === chartSource.length - 1,
    }));

    return (
      <View
        style={[
          { borderRadius: mobileMetrics.cardRadius, backgroundColor: colors.card, padding: 16, gap: 14 },
          shadow,
        ]}
      >
        <FilterChipRow
          options={OVERVIEW_METRICS.map((m) => ({ value: m.value, label: t(m.labelKey) }))}
          value={metric}
          onChange={setMetric}
        />
        <FilterChipRow
          options={OVERVIEW_RANGES.map((r) => ({ value: r.value, label: t(r.labelKey) }))}
          value={range}
          onChange={setRange}
        />
        <Text
          style={{
            fontSize: Math.round(type.titleSize * 0.95),
            fontWeight: '700',
            color: colors.text,
            textAlign: isRTL ? 'right' : 'left',
          }}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          {realTotal}
        </Text>
        {hasChart ? (
          <OverviewChart
            data={points}
            variant={metric === 'sales' ? 'line' : 'bar'}
          />
        ) : (
          <EmptyState
            testID="home-overview-empty"
            icon="bar-chart-outline"
            title={seriesQuery.isPending ? t('common.loading') : t('home.overview.empty')}
            fill={false}
            action={
              siteId
                ? {
                    label: sync.isPending
                      ? t('home.overview.syncing')
                      : t('storeSettings.sync.button'),
                    onPress: () => {
                      setSyncNote(undefined);
                      sync.mutate();
                    },
                  }
                : undefined
            }
          />
        )}
        {syncNote ? (
          <Text testID="home-overview-sync-note" variant="caption" tone="muted">
            {syncNote}
          </Text>
        ) : null}
      </View>
    );
  }

  // Seeded by the selected store so the numbers switch when the store switches.
  const series = buildOverviewSeries(metric, range, siteId);

  const labels: string[] =
    range === 'week'
      ? t('home.overview.days').split(',')
      : range === 'year'
        ? t('home.overview.months').split(',')
        : series.values.map((_, i) => `${t('home.overview.weekShort')}${fmt.num(i + 1)}`);

  // Sales is shown as a smooth CUMULATIVE line (running total); other metrics stay as bars.
  const isLine = metric === 'sales';
  let runningTotal = 0;
  const chartValues = isLine
    ? series.values.map((v) => {
        runningTotal += v;
        return runningTotal;
      })
    : series.values;

  const points: OverviewPoint[] = chartValues.map((value, index) => ({
    label: labels[index] ?? '',
    value,
    highlight: index === chartValues.length - 1,
  }));

  const totalLabel =
    metric === 'sales' ? fmt.money(String(series.total), currency) : fmt.num(series.total);
  const up = series.trendPercent >= 0;
  const trendColor = up ? colors.statusActive : colors.statusDanger;
  const trendBg = up ? colors.statusActiveSoft : colors.statusDangerSoft;

  return (
    <View
      style={[
        {
          borderRadius: mobileMetrics.cardRadius,
          backgroundColor: colors.card,
          padding: 16,
          gap: 14,
        },
        shadow,
      ]}
    >
      {/* Metric selector */}
      <FilterChipRow
        options={OVERVIEW_METRICS.map((m) => ({ value: m.value, label: t(m.labelKey) }))}
        value={metric}
        onChange={setMetric}
      />

      {/* Headline total + trend. The total takes the row and shrinks; "vs previous" sits on its
          own line so neither is ever clipped. */}
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: rowDirection, alignItems: 'center', gap: 10 }}>
          <Text
            style={{
              flexShrink: 1,
              fontSize: Math.round(type.titleSize * 0.95),
              fontWeight: '700',
              color: colors.text,
              textAlign: isRTL ? 'right' : 'left',
            }}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            {totalLabel}
          </Text>
          <View
            style={{
              flexDirection: rowDirection,
              alignItems: 'center',
              gap: 3,
              paddingHorizontal: 8,
              paddingVertical: 3,
              borderRadius: 999,
              backgroundColor: trendBg,
            }}
          >
            <Ionicons name={up ? 'arrow-up' : 'arrow-down'} size={12} color={trendColor} />
            <Text style={{ fontSize: 12, fontWeight: '700', color: trendColor }}>
              {fmt.num(Math.abs(series.trendPercent))}%
            </Text>
          </View>
        </View>
        <Text
          style={{
            fontSize: type.captionSize,
            color: colors.textSecondary,
            textAlign: isRTL ? 'right' : 'left',
          }}
        >
          {t('home.overview.vsPrev')}
        </Text>
      </View>

      <OverviewChart
        data={points}
        variant={isLine ? 'line' : 'bar'}
        testID="home-overview-chart"
      />

      {/* Range selector */}
      <FilterChipRow
        options={OVERVIEW_RANGES.map((r) => ({ value: r.value, label: t(r.labelKey) }))}
        value={range}
        onChange={setRange}
      />
    </View>
  );
}

export function MobileHomeScreen(): React.JSX.Element {
  const colors = useMobileColors();
  const shadow = useMobileShadow();
  const t = useT();
  const router = useRouter();
  const go = (href: string): void => router.navigate(href as never);
  const { data: sites, isPending } = useSites();
  const { data: activeSite } = useActiveSite();
  const onboardingQuery = useOnboardingRequests();
  const setActiveSite = useSetActiveSite();
  // The store being VIEWED in the carousel (drives the overview instantly); defaults to active.
  const [viewSiteId, setViewSiteId] = useState<string | undefined>(undefined);

  // Showcase (mock) build keeps illustrative counters/trends; production (real backend) must
  // never show fake data — real numbers only, or a clean empty state.
  const showcase = !isApiConfigured();

  const siteList = sites ?? [];
  const hasSites = siteList.length > 0;
  const pendingSiteCards = (onboardingQuery.data ?? [])
    .filter(isPendingOnboardingRequest)
    .map(onboardingToPendingCard);
  const showHero = hasSites || pendingSiteCards.length > 0;

  const currentSiteId = viewSiteId ?? activeSite?.id;
  const selectedSite = hasSites
    ? (siteList.find((s) => s.id === currentSiteId) ?? activeSite ?? siteList[0])
    : undefined;

  // Real, synced overview (production only). Drives real counts + headline totals; never faked.
  const { data: overview } = useQuery({
    queryKey: ['dashboard', 'overview', selectedSite?.id ?? 'none'],
    queryFn: () => dashboardService.getOverview(selectedSite?.id),
    enabled: !showcase && hasSites && Boolean(selectedSite?.id),
  });

  const renewalFor = (site: SiteConnection): string | undefined => {
    const key = SITE_RENEWAL_KEYS[site.id];
    return key ? t(key) : undefined;
  };

  // Swiping the carousel PREVIEWS a store (updates the at-a-glance overview here) without
  // changing the global active store.
  const handleSelectSite = (siteId: string): void => {
    setViewSiteId(siteId);
  };

  // Tapping "Set as active" on a card switches the ACTIVE store, so every site-scoped screen
  // (products / orders / customers) and the overview reflect the chosen store everywhere.
  const handleActivateSite = (siteId: string): void => {
    setViewSiteId(siteId);
    if (siteId !== activeSite?.id) {
      setActiveSite.mutate(siteId);
    }
  };

  if (isPending) {
    return (
      <MobilePage testID="mobile-home-screen">
        <View style={{ paddingHorizontal: mobileMetrics.screenPadding, paddingTop: 40 }}>
          <LoadingState />
        </View>
      </MobilePage>
    );
  }

  const orderCount = showcase
    ? quickActionCountsForSite(selectedSite?.id).orders
    : (overview?.ordersCount || undefined);

  return (
    <MobilePage testID="mobile-home-screen">
      <View style={{ paddingHorizontal: mobileMetrics.screenPadding, gap: 24 }}>
        {/* Hero / site state */}
        <AnimatedSection index={0}>
          {!showHero ? (
            <EmptySiteCard
              onPrimary={() => go('/create-site')}
              onSecondary={() => go('/connect-site')}
            />
          ) : (
            <SiteCarousel
              sites={siteList}
              pendingRequests={pendingSiteCards}
              initialActiveSiteId={activeSite?.id}
              activeSiteId={activeSite?.id}
              onSelectSite={handleSelectSite}
              onActivateSite={handleActivateSite}
              onPressSite={() => go('/plans')}
              onPressAdd={() => go('/create-site')}
              onPressPending={(requestId) => go(`/onboarding/${requestId}`)}
              renewalFor={renewalFor}
            />
          )}
        </AnimatedSection>

        {/* Quick actions */}
        <AnimatedSection index={1}>
          <SectionTitle title={t('home.quick.title')} />
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {QUICK_ACTIONS.map((action) => (
              <View key={action.key} style={{ flex: 1, minWidth: 0 }}>
                <QuickActionCard
                  icon={action.icon}
                  label={t(action.labelKey)}
                  // Counts are real-data only. In production show the real orders count (if any);
                  // showcase keeps illustrative counters. Never render a fake/demo badge in prod.
                  count={
                    showcase
                      ? action.key === 'orders'
                        ? orderCount
                        : action.count
                      : action.key === 'orders'
                        ? orderCount
                        : undefined
                  }
                  onPress={() => go(action.href)}
                  testID={`quick-${action.key}`}
                />
              </View>
            ))}
          </View>
        </AnimatedSection>

        {/* More features entry */}
        <AnimatedSection index={2}>
          <MoreEntryCard onPress={() => go('/more')} />
        </AnimatedSection>

        {/* At-a-glance overview chart (metric + range options) */}
        <AnimatedSection index={3}>
          <SectionTitle title={t('home.overview.title')} />
          <OverviewSection
            currency={selectedSite?.currency ?? 'IRR'}
            siteId={selectedSite?.id}
            showcase={showcase}
            overview={overview}
          />
        </AnimatedSection>

        {/* Short recent activity */}
        <AnimatedSection index={4}>
          <SectionTitle title={t('home.activity.title')} />
          <View
            style={[
              {
                borderRadius: mobileMetrics.cardRadius,
                backgroundColor: colors.card,
                paddingHorizontal: 16,
                paddingVertical: showcase ? 4 : 16,
              },
              shadow,
            ]}
          >
            {showcase ? (
              RECENT_ACTIVITY.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? (
                    <View style={{ height: 1, backgroundColor: colors.separator }} />
                  ) : null}
                  <MiniActivityRow
                    icon={item.icon}
                    tint={item.tint}
                    title={t(item.titleKey)}
                    caption={t(item.captionKey)}
                    onPress={() => go('/notifications')}
                  />
                </View>
              ))
            ) : (
              // No real activity feed yet — clean empty state, never mock activity in production.
              <EmptyState
                testID="home-activity-empty"
                icon="time-outline"
                title={t('home.activity.empty')}
                fill={false}
              />
            )}
          </View>
        </AnimatedSection>
      </View>
    </MobilePage>
  );
}
