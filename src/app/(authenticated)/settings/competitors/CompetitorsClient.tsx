'use client';

// Owner-facing Named rival picker (#546 Task 5). One <select> per active
// location, fed by the `RivalPickerView` the server already resolved — the
// component never filters, sorts, or re-derives anything about a Competitor
// pack; `src/lib/competitors/named-rival.ts` owns all of that.

import { useId, useState } from 'react';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { RivalOption, RivalPickerView } from '@/lib/competitors/named-rival';

const AUTO_DEFAULT_LABEL = 'Auto-selected (nearest ahead)';
const DROPPED_SUFFIX = ' — not in the latest pack';
const PACK_REFRESHED_MESSAGE =
  "The competitor pack refreshed while you were choosing — we've reloaded the latest rivals.";
const PACK_RELOAD_FAILED_MESSAGE =
  `${PACK_REFRESHED_MESSAGE} Reload the page to see the current rivals.`;
const MISSING_VALUE = '—';

interface LocationSummary {
  id: string;
  name: string;
}

interface Props {
  views: RivalPickerView[];
  locations: LocationSummary[];
  multiLocation: boolean;
}

/** The location a message belongs to, so a two-location page never mislabels it. */
interface Notice {
  businessId: string;
  message: string;
}

export function CompetitorsClient({ views: initialViews, locations, multiLocation }: Props) {
  const [views, setViews] = useState<RivalPickerView[]>(initialViews);
  // Multi-location settings mode also requires the flag, so an account with
  // several locations and the flag off would otherwise render several
  // indistinguishable pickers. Name every block whenever there is more than one.
  const showLocationNames = multiLocation || views.length > 1;
  const [savingId, setSavingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  function replaceView(next: RivalPickerView) {
    setViews((current) => current.map((view) => (
      view.businessId === next.businessId ? next : view
    )));
  }

  /**
   * Re-reads one location's view after the server rejected a pick as stale.
   * Never rethrows: the caller has already reported the refresh, and a failed
   * reload only widens that message to "reload the page" rather than leaving
   * the owner staring at a select that no longer matches the pack.
   */
  async function reloadView(businessId: string): Promise<void> {
    try {
      const res = await fetch(`/api/settings/competitors?businessId=${businessId}`);
      if (!res.ok) throw new Error(`GET ${res.status}`);
      replaceView((await res.json()) as RivalPickerView);
    } catch {
      setNotice({ businessId, message: PACK_RELOAD_FAILED_MESSAGE });
    }
  }

  async function savePick(businessId: string, selected: string) {
    setSavingId(businessId);
    setNotice(null);
    try {
      const res = await fetch('/api/settings/competitors', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId, placeId: selected === '' ? null : selected }),
      });
      const body: unknown = await res.json().catch(() => null);

      if (res.ok) {
        replaceView(body as RivalPickerView);
        return;
      }
      if (res.status === 409 && errorCode(body) === 'pack_refreshed') {
        setNotice({ businessId, message: PACK_REFRESHED_MESSAGE });
        await reloadView(businessId);
        return;
      }
      setNotice({ businessId, message: saveErrorMessage(body, res.status) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'the request failed';
      setNotice({ businessId, message: `Could not save your rival pick — ${detail}.` });
    } finally {
      setSavingId(null);
    }
  }

  return (
    <SettingsShell saveError={notice?.message}>
      <section className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon sage" aria-hidden>
            <Icon name="chart" size={18} />
          </div>
          <div>
            <h2 className="set-section-title">Named rival</h2>
            <div className="set-section-sub">
              Your weekly digest tracks one local-pack rival per location. Pick the one you
              care about, or leave it on the auto-selected rival — the competitor just ahead
              of you on review count.
            </div>
          </div>
        </div>

        {views.map((view) => (
          <LocationRivalPicker
            key={view.businessId}
            view={view}
            locationName={locationName(locations, view.businessId)}
            showLocationName={showLocationNames}
            saving={savingId === view.businessId}
            notice={notice?.businessId === view.businessId ? notice.message : null}
            onSelect={(selected) => void savePick(view.businessId, selected)}
          />
        ))}

        {views.length === 0 && (
          <p className="set-section-sub">No active locations are available for this account.</p>
        )}
      </section>
    </SettingsShell>
  );
}

function LocationRivalPicker({
  view,
  locationName: name,
  showLocationName,
  saving,
  notice,
  onSelect,
}: {
  view: RivalPickerView;
  locationName: string;
  showLocationName: boolean;
  saving: boolean;
  notice: string | null;
  onSelect: (selected: string) => void;
}) {
  const selectId = useId();

  return (
    <div
      className="field"
      // A single-location page has one picker and a page title above it; only
      // the multi-location page needs each block named.
      role={showLocationName ? 'group' : undefined}
      aria-label={showLocationName ? name : undefined}
    >
      {showLocationName && <div className="set-section-title">{name}</div>}

      {view.state === 'not_configured' && (
        <p className="set-section-sub">
          {"Competitor tracking isn't set up for this location yet."}
        </p>
      )}

      {view.state === 'awaiting_pack' && (
        <p className="set-section-sub">
          {`We're watching '${view.keyword}' — the first competitor pack lands after the next check.`}
        </p>
      )}

      {view.state === 'ready' && view.options.length === 0 && (
        <p className="set-section-sub">
          {`No competitors were found in the latest pack for '${view.keyword}'.`}
        </p>
      )}

      {view.state === 'ready' && view.options.length > 0 && (
        <>
          <label className="field-label" htmlFor={selectId}>
            {`Named rival for '${view.keyword}'`}
          </label>
          <select
            id={selectId}
            className="input"
            value={view.pick?.placeId ?? ''}
            disabled={saving}
            onChange={(event) => onSelect(event.target.value)}
          >
            <option value="">{AUTO_DEFAULT_LABEL}</option>
            {view.options.map((option) => (
              <option key={option.placeId} value={option.placeId}>
                {optionLabel(option)}
              </option>
            ))}
            {/* A pick survives the rival's absence from the pack, so it stays
                selectable — and selected — until the owner changes it. */}
            {view.pick && !view.pick.inLatestPack && (
              <option value={view.pick.placeId}>{`${view.pick.title}${DROPPED_SUFFIX}`}</option>
            )}
          </select>
          <span className="field-hint">Rank · name · reviews · rating</span>
        </>
      )}

      {notice && <p className="auto-policy-warning">{notice}</p>}
    </div>
  );
}

function optionLabel(option: RivalOption): string {
  return `#${option.rankPosition ?? MISSING_VALUE}  ${option.title}  ${option.reviewCount ?? MISSING_VALUE} · ${option.rating ?? MISSING_VALUE}`;
}

function locationName(locations: LocationSummary[], businessId: string): string {
  return locations.find((location) => location.id === businessId)?.name ?? 'This location';
}

function errorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  return 'error' in body && typeof body.error === 'string' ? body.error : null;
}

function saveErrorMessage(body: unknown, status: number): string {
  const code = errorCode(body);
  return code
    ? `Could not save your rival pick — ${code.replace(/_/g, ' ')}.`
    : `Could not save your rival pick (${status}).`;
}
