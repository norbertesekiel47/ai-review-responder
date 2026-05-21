# Suggested Improvements

This document tracks potential optimizations, refactors, and architectural enhancements identified during the codebase investigation.

## Middleware (`src/middleware.ts`)

- [ ] **Cache `readSelf()` lookups**: Currently, the middleware queries the database for the user's role/business_id on every protected request. Implementing a short-lived cache (e.g., using the existing Upstash Redis) would significantly reduce latency and database load.
- [ ] **Optimize config matcher**: Move more route-filtering logic into the `config.matcher` to prevent the middleware from executing on public paths that don't require auth checks.
- [ ] **User Context Headers**: Inject `x-user-role` and `x-business-id` into request headers after the middleware validates them. This allows downstream Server Components and API routes to access this data without redundant DB queries.
- [ ] **Feature-Flagged "Coming Soon" Mode**: Move the hardcoded `repworth.net` logic into an environment variable or a configuration-based feature flag to make it easier to toggle without code changes.

## App Structure (`src/app`)

- [ ] **Branded 404 Page (`not-found.tsx`)**: Implement a root-level `not-found.tsx` file to provide a consistent, branded experience when users navigate to non-existent routes.
- [ ] **Instant Loading States (`loading.tsx`)**: Add `loading.tsx` files to route groups (like `(authenticated)`) to provide immediate feedback (skeletons or spinners) while Server Components fetch data.
- [ ] **Dynamic Metadata & SEO**: Move the static metadata in the Root Layout to a more dynamic setup or add specific metadata to public pages (pricing, features) to improve SEO.
- [ ] **Global Toast/Notification Provider**: Wrap the Root Layout in a context provider for notifications to handle success/error messages across the entire app consistently.

## Authenticated Experience (`src/app/(authenticated)`)

- [ ] **Layout Data Prefetching**: The `AuthenticatedLayout` performs two sequential SQL queries. These could be combined into a single query with a JOIN to reduce database roundtrips.
- [ ] **Centralized Business Context**: Instead of re-fetching business details in multiple components, use a React Context or a shared state manager (or even just the injected headers mentioned in the Middleware section) to provide business info to the entire authenticated tree.
- [ ] **Client-Side Navigation Prefetching**: Ensure that expensive dashboard tabs (like "Past Replies") are efficiently prefetched or use `Suspense` more aggressively to prevent the UI from feeling sluggish during transitions.
- [ ] **Error Boundaries for Components**: Wrap key dashboard widgets (like the "Connect Google" flow) in localized Error Boundaries so that a single failure doesn't crash the entire dashboard.

## Public Routes (`src/app/(public)`)

- [ ] **Shared Public Layout**: Implement a unified Header and Footer in `src/app/(public)/layout.tsx` to ensure a consistent marketing experience across landing, features, and pricing pages.
- [ ] **Automated Sitemap & Robots.txt**: Add `sitemap.ts` and `robots.ts` in the `app` root to automatically index marketing pages and improve search engine rankings.
- [ ] **Optimized Approval Page**: Since the `approve/[token]` page is a high-intent user touchpoint, optimize its bundle size and prioritize "above the fold" rendering of the review draft.
- [ ] **Lead Capture Honeypot**: Add basic honeypot protection to the `book-a-demo` and `signup` forms to prevent spam submissions without degrading the UX with intrusive CAPTCHAs.

## Admin Panel (`src/app/admin`)

- [ ] **Real-time System Health Webhooks**: Instead of polling `/api/admin/overview` every 30 seconds, consider using a WebSocket or a real-time subscription (Supabase or custom) for critical "red state" health alerts.
- [ ] **Bulk Business Actions**: Add the ability to bulk-reconnect, bulk-pause, or bulk-export data for businesses from the admin overview table.
- [ ] **Enhanced Audit Logging UI**: While data exists in the DB, the Admin UI could benefit from a dedicated "Audit Log" view to track who changed what in business settings or job configurations.
- [ ] **Job Retry/DLQ Management UI**: Expand the `jobs` page to allow admins to manually retry failed outbox jobs or move items out of a Dead Letter Queue directly from the browser.
- [ ] **Cost Anomaly Detection**: Add a visual indicator or automated alert in the `costs` view when API spend spikes unexpectedly compared to the 7-day average.

## API Routes (`src/app/api`)

- [ ] **Standardized Error Responses**: Implement a shared helper function (e.g., `createApiError`) to ensure all API routes return a consistent JSON error shape (e.g., `{ error: string, code?: string, details?: any }`).
- [ ] **Zod Input Validation**: Use Zod schemas for all `POST` and `PUT` request bodies. This provides type-safe parsing and automatically returns descriptive validation errors to the client.
- [ ] **API Documentation (OpenAPI/Swagger)**: Generate or manually maintain an OpenAPI spec for the `admin` and `dashboard` APIs to make it easier to toggle without code changes.
- [ ] **Rate Limiting (Per-User)**: Add stricter rate limiting to the `onboarding` and `demo-request` endpoints to prevent automated abuse, using the existing Redis instance.
- [ ] **Query Performance (Admin Overview)**: The `admin/overview` API performs many complex `sql.all` queries. As the business count grows, consider materializing some health metrics or using a more optimized reporting table to keep response times low.

## React Hooks (`src/hooks`)

- [ ] **Migrate `useDashboardData` to React Query**: The current implementation uses manual `fetch` and `useEffect`. Migrating to `useQuery` (already used in the admin panel) would provide out-of-the-box caching, background refetching, and automatic loading/error states.
- [ ] **Add `isLoading` state**: The `useDashboardData` hook currently lacks an `isLoading` flag, making it difficult to show loading skeletons or spinners in the UI without tracking local state elsewhere.
- [ ] **Implement Polling**: For the dashboard, implementing automatic background polling (e.g., every 2 minutes) would keep the user's review counts and status fresh without manual refreshes.

## Components (`src/components`)

- [ ] **Atomic UI Design**: Create a `src/components/ui` folder for primitive components (Button, Badge, StarRating, Modal, Input). Currently, logic like `renderStars` and `STATUS_BADGE_COLORS` is duplicated or localized inside specific components like `ReviewsList.tsx`.
- [ ] **Centralized Status Formatting**: Move the `formatStatusLabel` and status color mapping to a shared utility or a central `Badge` component to ensure consistency between the Dashboard, Admin, and Settings views.
- [ ] **A11y (Accessibility) Audit**: Improve ARIA roles in custom components. For example, ensure the star ratings use `aria-label` correctly and that complex interactive elements like `ReviewActions` are fully keyboard-navigable.
- [ ] **Responsive Navigation Refactor**: The `OwnerNav` and `AdminNav` could be unified into a single responsive navigation component that handles both desktop and mobile views (including a hamburger menu for small screens).
- [ ] **Memoization Optimization**: Use `React.memo` for data-heavy components like `ReviewsList` or `Charts` to prevent unnecessary re-renders when other parts of the dashboard state change.

## Core Logic (`src/lib`)

- [ ] **LLM Fallback Logic**: The `responses/generator.ts` identifies Anthropic as a fallback. Explicitly implement an automated retry circuit that switches providers (OpenAI → Anthropic) if the primary LLM is down.
- [ ] **Review Language Detection Edge Cases**: For very short reviews, the language detection defaults to English. Improve this by using the LLM itself to detect language for 1-3 word reviews during the generation phase.
- [ ] **Database Migration Safety**: Ensure all new migrations in `supabase/migrations` include `DROP ... IF EXISTS` and `CREATE ... IF NOT EXISTS` to prevent deployment failures in CI/CD environments.
- [ ] **Centralized Event Dispatcher**: Instead of manually inserting into `job_outbox` in multiple lib files, create a shared `events` service that handles consistent payload formatting and transactional safety.
- [ ] **Pub/Sub for Real-time UI**: Integrate a Pub/Sub mechanism (e.g., Supabase Realtime or Redis) so that the UI can update instantly when a background worker finishes generating a response.
