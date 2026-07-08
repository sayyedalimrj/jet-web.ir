/**
 * Adapter interfaces — the seam between the app and any data source.
 *
 * Screens never call these directly; they go through services + query hooks. The MVP wires
 * mock implementations. A future `http` implementation will target OUR backend/proxy with an
 * identical surface, so no screen code changes when real data arrives (design.md §5).
 *
 * Mutations are intentionally limited in this task to mock session/site state. Catalog/order
 * mutations (create/edit/delete, status updates) and any real store writes are gated on the
 * security review (see security steering).
 */
import type {
  AbandonedCartSignal,
  AddInternalNoteInput,
  AnalyticsProviderStatus,
  AnalyticsReadiness,
  AIAdvisorConversationMessage,
  AIAdvisorInsight,
  AIAdvisorPromptSuggestion,
  AIAdvisorRecommendation,
  AIAdvisorStoreContextSummary,
  AuthSession,
  AutomationRule,
  AutomationSafetyNotice,
  BackInStockInterest,
  BackInStockSubscription,
  BillingInterval,
  BillingProviderStatus,
  CampaignConversionSignal,
  CampaignDraft,
  CampaignMessagePreview,
  CampaignReadinessReport,
  CommerceEvent,
  ConnectSiteInput,
  ConsentReadiness,
  ConversionFunnelReport,
  CurrentSubscriptionSummary,
  Customer,
  CustomerListQuery,
  CustomerReport,
  DashboardOverview,
  EventProviderStatus,
  EventTrackingReadiness,
  ExecutiveSummary,
  ExistingOnboardingInput,
  ExistingSiteOnboardingRequest,
  IntelligenceRecommendation,
  IntelligenceSummary,
  InventoryReport,
  MediaStudioAnalyzeInput,
  MediaStudioAsset,
  MediaStudioGenerationInput,
  MediaStudioGenerationRequest,
  MediaStudioOutputVariant,
  MediaStudioProviderStatus,
  MediaStudioPromptSuggestion,
  MediaStudioSafetyNotice,
  MediaStudioVideoConcept,
  NewLaunchInput,
  NewStoreLaunchRequest,
  NotificationProviderStatus,
  NotificationReadiness,
  OnboardingRequest,
  Order,
  OrderListQuery,
  Paged,
  PlanChangePreview,
  PlanChangeRequestResult,
  PlanFeature,
  PlanPricing,
  Product,
  ProductInterestSignal,
  ProductListQuery,
  ProductPerformanceReport,
  ProductCreateInput,
  ProductUpdateInput,
  RecordEventInput,
  ReportInsight,
  ReportPeriod,
  ReportRecommendation,
  SalesReport,
  SearchDemandInsight,
  SearchDemandReport,
  SiteConnection,
  StoreTemplate,
  SubscriptionPlan,
  SubscriptionPlanId,
  SupportConversation,
  SupportQueueItem,
  SupportRequestStatus,
} from '@/domain/types';

export interface AuthAdapter {
  /** Establish a mock authenticated session (no real credentials). */
  signInMock(input?: { email?: string; name?: string }): Promise<AuthSession>;
  /** Clear the session. */
  signOut(): Promise<AuthSession>;
  /** Read the current session (mock). */
  getSession(): Promise<AuthSession>;
}

export interface SiteAdapter {
  /** List connected sites (frontend-safe metadata only). */
  listSites(): Promise<SiteConnection[]>;
  /** The currently active site, or null when none is selected. */
  getActiveSite(): Promise<SiteConnection | null>;
  /** Set the active site by id; returns the new active site. */
  setActiveSite(siteId: string): Promise<SiteConnection>;
  /**
   * Connect a site in the mock layer. Accepts only non-secret metadata (name + URL).
   * Real credentials are never accepted here; production connection goes via backend/proxy.
   */
  connectMockSite(input: ConnectSiteInput): Promise<SiteConnection>;
  /** Disconnect/remove a site from the mock layer. */
  disconnectMockSite(siteId: string): Promise<void>;
}

export interface DashboardAdapter {
  /** Overview ("operating home") for the active site. */
  getOverview(siteId?: string): Promise<DashboardOverview>;
}

export interface ProductAdapter {
  listProducts(query?: ProductListQuery): Promise<Paged<Product>>;
  getProduct(id: string): Promise<Product>;
  /**
   * Update controlled product fields (name/price/stock/status/categories). In live mode this
   * writes to WooCommerce via the backend and re-syncs the read-model; in mock mode it updates
   * the in-memory catalog. Returns the updated product.
   */
  updateProduct(id: string, input: ProductUpdateInput): Promise<Product>;
  /** Delete (trash) a product in the connected store and drop it from the read-model. */
  deleteProduct(id: string): Promise<void>;
  /**
   * Create a simple product. In live mode this creates it in WooCommerce and returns its REAL
   * resulting status (publish/draft) so the UI never claims a fake "submitted for review"; in mock
   * mode it adds to the in-memory catalog. Returns the created product.
   */
  createProduct(input: ProductCreateInput): Promise<Product>;
}

export interface OrderAdapter {
  listOrders(query?: OrderListQuery): Promise<Paged<Order>>;
  getOrder(id: string): Promise<Order>;
}

export interface CustomerAdapter {
  listCustomers(query?: CustomerListQuery): Promise<Paged<Customer>>;
  getCustomer(id: string): Promise<Customer>;
}

/**
 * Onboarding adapter — the seam for the "two front doors" onboarding platform (Phase 1).
 *
 * Mock-only: it lists the template catalog + plan placeholders, lists/reads onboarding
 * requests, and creates requests for both paths. It accepts ONLY frontend-safe input (no
 * credentials of any kind). Real provisioning/connection happens server-side later; a future
 * `http` implementation will target OUR backend/proxy with the same surface.
 */
export interface OnboardingAdapter {
  /** Prepared WordPress/WooCommerce store templates (mock catalog). */
  listTemplates(): Promise<StoreTemplate[]>;
  /** Subscription plan placeholders (no billing). */
  listPlans(): Promise<SubscriptionPlan[]>;
  /** All onboarding requests (both paths), newest first. */
  listRequests(): Promise<OnboardingRequest[]>;
  /** A single onboarding request by id. */
  getRequest(id: string): Promise<OnboardingRequest>;
  /** Create a Path A (existing-site) request. No credential fields are accepted. */
  createExistingSiteRequest(input: ExistingOnboardingInput): Promise<ExistingSiteOnboardingRequest>;
  /** Create a Path B (new-store launch) request. No credential fields are accepted. */
  createStoreLaunchRequest(input: NewLaunchInput): Promise<NewStoreLaunchRequest>;
}

/**
 * Support adapter — the seam for the internal support/operations queue (Phase 2).
 *
 * Mock-only and in-memory: it lists/reads queue items and performs staff actions (status
 * progression, assignment, checklist toggles, internal notes). All data is frontend-safe;
 * no method accepts or returns credentials. A future `apps/admin` + `apps/api` take over
 * this surface without UI rework. There is NO real provisioning, connection, or notification.
 */
export interface SupportAdapter {
  /** All support queue items, sorted by the adapter. */
  listSupportQueue(): Promise<SupportQueueItem[]>;
  /** A single queue item by id. */
  getSupportRequest(id: string): Promise<SupportQueueItem>;
  /** Move a request to a new status (mock-only; appends a timeline event). */
  updateSupportStatus(id: string, status: SupportRequestStatus): Promise<SupportQueueItem>;
  /** Assign/unassign a teammate (mock-only). Pass null to unassign. */
  assignSupportRequest(id: string, assigneeId: string | null): Promise<SupportQueueItem>;
  /** Toggle a checklist/playbook item (mock-only). */
  toggleChecklistItem(id: string, checklistItemId: string): Promise<SupportQueueItem>;
  /** Add a frontend-safe internal note (mock-only). */
  addInternalNote(id: string, input: AddInternalNoteInput): Promise<SupportQueueItem>;
}

/**
 * Support messaging adapter — the seam for the merchant-facing support chat.
 *
 * Mock-only and in-memory for now: it reads the merchant's support conversation and appends a
 * customer message (returning a canned agent reply). It is the bridge point to the internal
 * admin support inbox: a future `http` implementation posts/reads through OUR backend, which
 * persists messages in the shared support tables that `apps/admin` reads and replies to — so
 * the same conversation is mirrored on both sides with NO UI rework. Frontend-safe only; no
 * method accepts or returns credentials, and nothing is sent to any external provider.
 */
export interface SupportMessagingAdapter {
  /** The merchant's current support conversation (seeded with a greeting in the mock). */
  getConversation(): Promise<SupportConversation>;
  /** Append a customer message; returns the updated thread (mock adds a canned agent reply). */
  sendMessage(body: string): Promise<SupportConversation>;
}

/**
 * Billing/subscription adapter — the seam for the pricing & plans module (Phase 3).
 *
 * Mock-only and FRONTEND-SAFE: it lists plans + display-only pricing + the feature matrix,
 * reports the (mock) current subscription, and previews/acknowledges plan changes WITHOUT
 * any real charge. It never touches payment methods, card data, provider secrets, or real
 * billing IDs. A future `services/billing` + provider integration replaces this surface
 * after a security review (see security-model.md).
 */
export interface BillingAdapter {
  /** The four platform plans (reuses the shared SubscriptionPlan identity). */
  listPlans(): Promise<SubscriptionPlan[]>;
  /** Display-only per-plan pricing across intervals. */
  listPlanPricing(): Promise<PlanPricing[]>;
  /** The feature-comparison matrix. */
  listPlanFeatures(): Promise<PlanFeature[]>;
  /** The merchant's current (mock) subscription summary. */
  getCurrentSubscription(): Promise<CurrentSubscriptionSummary>;
  /** Whether a real billing provider is wired (it is not). */
  getProviderStatus(): Promise<BillingProviderStatus>;
  /** Preview a plan change relative to the current plan (mock-only; no charge). */
  previewPlanChange(
    planId: SubscriptionPlanId,
    interval: BillingInterval,
  ): Promise<PlanChangePreview>;
  /** Acknowledge a mock plan-change request (no backend, no charge, no state change). */
  requestPlanChangeMock(
    planId: SubscriptionPlanId,
    interval: BillingInterval,
  ): Promise<PlanChangeRequestResult>;
}

/**
 * AI Business Advisor adapter — the seam for the mock commerce assistant (Phase 4).
 *
 * Mock-only: it returns a frontend-safe store-context summary, insights, review-only
 * recommendations, prompt chips, and a DETERMINISTIC mock conversation. It calls NO AI
 * provider/API, sends nothing externally, and mutates no real store data. `siteId` is
 * accepted for forward-compatibility but ignored by the mock. A future real provider goes
 * through a backend/provider adapter with permission checks + merchant approval.
 */
export interface AIAdvisorAdapter {
  getStoreContextSummary(siteId?: string): Promise<AIAdvisorStoreContextSummary>;
  listInsights(siteId?: string): Promise<AIAdvisorInsight[]>;
  listRecommendations(siteId?: string): Promise<AIAdvisorRecommendation[]>;
  listPromptSuggestions(siteId?: string): Promise<AIAdvisorPromptSuggestion[]>;
  getConversation(siteId?: string): Promise<AIAdvisorConversationMessage[]>;
  /** Append the user message + a deterministic mock assistant reply; returns the thread. */
  sendAdvisorMessageMock(message: string, siteId?: string): Promise<AIAdvisorConversationMessage[]>;
  /** Mark a recommendation reviewed (mock-only); returns the updated list. */
  markRecommendationReviewed(id: string): Promise<AIAdvisorRecommendation[]>;
  /** Dismiss a recommendation (mock-only); returns the updated list. */
  dismissRecommendationMock(id: string): Promise<AIAdvisorRecommendation[]>;
}

/**
 * AI Product Media Studio adapter — the seam for the mock product-media workflow (Phase 4b).
 *
 * Mock-only: analyzes a SIMULATED source image (preset-driven, no upload), suggests fixes,
 * and produces placeholder output-variant + promo-video concepts. It calls NO image/video
 * provider/API, uploads NO files, sends NO product image anywhere, and publishes/mutates
 * NOTHING. A future real provider must go through the backend with permission checks,
 * audit logs, asset-ownership checks, and merchant approval (see security-model.md).
 */
export interface MediaStudioAdapter {
  getProviderStatus(): Promise<MediaStudioProviderStatus>;
  listPromptSuggestions(productId?: string): Promise<MediaStudioPromptSuggestion[]>;
  listVideoConcepts(): Promise<MediaStudioVideoConcept[]>;
  listSafetyNotices(): Promise<MediaStudioSafetyNotice[]>;
  /** Analyze a simulated source asset (preset-driven); returns a mock quality analysis. */
  analyzeSourceAssetMock(input: MediaStudioAnalyzeInput): Promise<MediaStudioAsset>;
  /** Existing mock output variants for a product. */
  listOutputVariants(productId: string): Promise<MediaStudioOutputVariant[]>;
  /** Create mock output variants for a task (no real generation); returns the request. */
  createGenerationMock(input: MediaStudioGenerationInput): Promise<MediaStudioGenerationRequest>;
  /** A stored mock generation request by id. */
  getGenerationRequest(id: string): Promise<MediaStudioGenerationRequest>;
  /** Mark a variant reviewed (mock-only); returns the updated variants. */
  markVariantReviewed(id: string): Promise<MediaStudioOutputVariant[]>;
  /** Approve a variant (mock-only; nothing is published); returns the updated variants. */
  approveVariantMock(id: string): Promise<MediaStudioOutputVariant[]>;
  /** Dismiss a variant (mock-only); returns the updated variants. */
  dismissVariantMock(id: string): Promise<MediaStudioOutputVariant[]>;
}

/**
 * Customer Intelligence / Event Tracking adapter — the seam for the mock intelligence model
 * (Phase 5). Serves a mock event stream + derived signals (search demand, product interest,
 * back-in-stock, abandoned carts, campaign conversion) and review-only recommendations.
 *
 * SECURITY/PRIVACY (binding): MOCK-ONLY. NO real tracking, NO cookies/fingerprints, NO
 * analytics provider, NO external send, NO tracking/provider IDs, NO PII beyond mock data.
 * `recordEventMock` only appends to the in-memory stream. `siteId` is accepted for
 * forward-compatibility but ignored by the mock. See security-model.md.
 */
export interface CustomerIntelligenceAdapter {
  getProviderStatus(): Promise<EventProviderStatus>;
  getReadiness(): Promise<EventTrackingReadiness>;
  listEvents(siteId?: string): Promise<CommerceEvent[]>;
  getIntelligenceSummary(siteId?: string): Promise<IntelligenceSummary>;
  listSearchDemandInsights(siteId?: string): Promise<SearchDemandInsight[]>;
  listProductInterestSignals(siteId?: string): Promise<ProductInterestSignal[]>;
  listBackInStockInterests(siteId?: string): Promise<BackInStockInterest[]>;
  listAbandonedCartSignals(siteId?: string): Promise<AbandonedCartSignal[]>;
  listCampaignConversionSignals(siteId?: string): Promise<CampaignConversionSignal[]>;
  listRecommendations(siteId?: string): Promise<IntelligenceRecommendation[]>;
  /** Append a mock event to the in-memory stream (dev/mock only); returns the stream. */
  recordEventMock(input: RecordEventInput): Promise<CommerceEvent[]>;
  markRecommendationReviewed(id: string): Promise<IntelligenceRecommendation[]>;
  dismissRecommendationMock(id: string): Promise<IntelligenceRecommendation[]>;
}

/**
 * Notification / automation adapter — the seam for SMS & back-in-stock automation (Phase 6).
 *
 * Mock-only: lists back-in-stock subscriptions, automation rules, and review-only campaign
 * drafts, and builds consent-gated message previews. It calls NO SMS/email/WhatsApp provider
 * (no Kavenegar/Twilio/Klaviyo), sends NOTHING, stores NO real phone numbers/consent, and has
 * NO scheduler. `siteId` is accepted for forward-compatibility but ignored by the mock. Future
 * real sending must go through a backend/provider adapter with consent + opt-out + audit logs.
 */
export interface NotificationAutomationAdapter {
  getProviderStatus(): Promise<NotificationProviderStatus>;
  getReadiness(): Promise<NotificationReadiness>;
  getConsentReadiness(): Promise<ConsentReadiness>;
  listBackInStockSubscriptions(siteId?: string): Promise<BackInStockSubscription[]>;
  listAutomationRules(siteId?: string): Promise<AutomationRule[]>;
  listCampaignDrafts(siteId?: string): Promise<CampaignDraft[]>;
  listSafetyNotices(): Promise<AutomationSafetyNotice[]>;
  /** Build a deterministic, consent-gated message preview (no send). */
  previewCampaignMessage(draftId: string): Promise<CampaignMessagePreview>;
  /** Create a mock back-in-stock campaign draft for a product; returns the draft. */
  createBackInStockDraftMock(productId: string): Promise<CampaignDraft>;
  markDraftReviewed(id: string): Promise<CampaignDraft[]>;
  /** Approve a draft (mock-only; nothing is sent); returns the updated drafts. */
  approveDraftMock(id: string): Promise<CampaignDraft[]>;
  dismissDraftMock(id: string): Promise<CampaignDraft[]>;
}

/**
 * Reports & Analytics adapter — the seam for the lightweight, mock-only reporting module
 * (Phase 7). Serves an executive summary plus sales, product-performance, customer,
 * inventory, search-demand, campaign-readiness, and conversion-funnel reports, all derived
 * from the existing mock data, plus review-only insights/recommendations.
 *
 * SECURITY/PRIVACY (binding — see security-model.md): MOCK-ONLY. NO real analytics provider,
 * NO GA4, NO WooCommerce Reports API, NO tracking script/cookies, NO external send, NO real
 * analytics/provider IDs, NO API keys, NO secrets, NO export/download, and NO real date
 * engine — `period` only scales mock values. `siteId` is accepted for forward-compatibility
 * but ignored by the mock. Future real reporting goes through the backend/event pipeline.
 */
export interface ReportsAnalyticsAdapter {
  getProviderStatus(): Promise<AnalyticsProviderStatus>;
  getReadiness(): Promise<AnalyticsReadiness>;
  getExecutiveSummary(period: ReportPeriod, siteId?: string): Promise<ExecutiveSummary>;
  getSalesReport(period: ReportPeriod, siteId?: string): Promise<SalesReport>;
  getProductPerformanceReport(
    period: ReportPeriod,
    siteId?: string,
  ): Promise<ProductPerformanceReport>;
  getCustomerReport(period: ReportPeriod, siteId?: string): Promise<CustomerReport>;
  getInventoryReport(period: ReportPeriod, siteId?: string): Promise<InventoryReport>;
  getSearchDemandReport(period: ReportPeriod, siteId?: string): Promise<SearchDemandReport>;
  getCampaignReadinessReport(
    period: ReportPeriod,
    siteId?: string,
  ): Promise<CampaignReadinessReport>;
  getConversionFunnelReport(period: ReportPeriod, siteId?: string): Promise<ConversionFunnelReport>;
  listReportInsights(period: ReportPeriod, siteId?: string): Promise<ReportInsight[]>;
  listReportRecommendations(period: ReportPeriod, siteId?: string): Promise<ReportRecommendation[]>;
}

/** The full set of adapters resolved from configuration. */
export interface Adapters {
  auth: AuthAdapter;
  sites: SiteAdapter;
  dashboard: DashboardAdapter;
  products: ProductAdapter;
  orders: OrderAdapter;
  customers: CustomerAdapter;
  onboarding: OnboardingAdapter;
  support: SupportAdapter;
  supportMessaging: SupportMessagingAdapter;
  billing: BillingAdapter;
  advisor: AIAdvisorAdapter;
  mediaStudio: MediaStudioAdapter;
  intelligence: CustomerIntelligenceAdapter;
  automation: NotificationAutomationAdapter;
  reports: ReportsAnalyticsAdapter;
}
