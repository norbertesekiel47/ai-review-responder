'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardSettings } from '@/lib/dashboard/types';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

/** The light GET /api/settings payload — the only fields the settings pages
 *  read (previously satisfied by fetching the entire /api/dashboard). */
export interface SettingsPageData {
  business: { name: string; createdAt: string };
  settings: DashboardSettings;
}

/** GET /api/settings union: settings data, or a redirect-gate marker. */
type SettingsResponse = Partial<SettingsPageData> & {
  subscriptionStatus?: string;
  paymentUrl?: string | null;
};

export interface SettingsForm {
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
  ownerPhone: string;
  weeklySummaryEnabled: boolean;
  monthlyImpactEnabled: boolean;
}

function settingsToForm(s: DashboardSettings): SettingsForm {
  return {
    tone: s.tone,
    productsServices: s.productsServices,
    avoidFacts: s.avoidFacts.slice(),
    sampleResponses: s.sampleResponses.slice(),
    ownerPhone: s.ownerPhone,
    weeklySummaryEnabled: s.weeklySummaryEnabled,
    monthlyImpactEnabled: s.monthlyImpactEnabled,
  };
}

// One comparison branch per settings field — the count is the form-field
// vocabulary, unchanged by the light-endpoint swap.
// fallow-ignore-next-line complexity
function buildPatch(initial: SettingsForm, current: SettingsForm): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (current.tone !== initial.tone) patch.tone = current.tone;
  if (current.productsServices !== initial.productsServices) patch.productsServices = current.productsServices || null;
  if (JSON.stringify(current.avoidFacts) !== JSON.stringify(initial.avoidFacts)) {
    patch.avoidFacts = current.avoidFacts.flatMap((l) => {
      const trimmed = l.trim();
      return trimmed ? [trimmed] : [];
    });
  }
  if (JSON.stringify(current.sampleResponses) !== JSON.stringify(initial.sampleResponses)) {
    patch.sampleResponses = current.sampleResponses.flatMap((l) => {
      const trimmed = l.trim();
      return trimmed ? [trimmed] : [];
    });
  }
  if (current.ownerPhone !== initial.ownerPhone) patch.ownerPhone = current.ownerPhone || null;
  if (current.weeklySummaryEnabled !== initial.weeklySummaryEnabled) patch.weeklySummaryEnabled = current.weeklySummaryEnabled;
  if (current.monthlyImpactEnabled !== initial.monthlyImpactEnabled) patch.monthlyImpactEnabled = current.monthlyImpactEnabled;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function settingsRedirectForDashboardData(
  json: { subscriptionStatus?: string; paymentUrl?: string | null },
): string | null {
  if (json.subscriptionStatus === SubscriptionStatus.PENDING_PAYMENT) return json.paymentUrl ?? '/dashboard';
  if (
    json.subscriptionStatus === 'active_pending_business' ||
    json.subscriptionStatus === 'pending_payment_admin_handoff'
  ) {
    return '/dashboard';
  }
  return null;
}

export interface UseSettingsForm {
  data: SettingsPageData | null;
  form: SettingsForm | null;
  initial: SettingsForm | null;
  fetchError: string | null;
  saveError: string | null;
  saving: boolean;
  savedFlash: boolean;
  dirty: boolean;
  dirtyCount: number;
  set: <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => void;
  save: () => Promise<void>;
  discard: () => void;
}

export function useSettingsForm(): UseSettingsForm {
  const [data, setData] = useState<SettingsPageData | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [initial, setInitial] = useState<SettingsForm | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    // fallow-ignore-next-line complexity
    async function load() {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const json: SettingsResponse = await res.json();
        if (cancelled) return;
        const redirectUrl = settingsRedirectForDashboardData(json);
        if (redirectUrl) {
          window.location.href = redirectUrl;
          return;
        }
        if (!json.business || !json.settings) {
          throw new Error('Malformed settings response');
        }
        const page: SettingsPageData = { business: json.business, settings: json.settings };
        setData(page);
        const f = settingsToForm(page.settings);
        setForm(f);
        setInitial(f);
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : 'Failed to load settings');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => {
    if (!form || !initial) return false;
    return buildPatch(initial, form) !== null;
  }, [form, initial]);

  // fallow-ignore-next-line complexity
  const dirtyCount = useMemo(() => {
    if (!form || !initial) return 0;
    let n = 0;
    for (const k of Object.keys(form) as (keyof SettingsForm)[]) {
      if (JSON.stringify(form[k]) !== JSON.stringify(initial[k])) n++;
    }
    return n;
  }, [form, initial]);

  function set<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  // fallow-ignore-next-line complexity
  async function save() {
    if (!form || !initial) return;
    const patch = buildPatch(initial, form);
    if (!patch) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      setInitial({ ...form });
      setSavedFlash(true);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setSavedFlash(false), 1800);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (initial) setForm({ ...initial });
  }

  return { data, form, initial, fetchError, saveError, saving, savedFlash, dirty, dirtyCount, set, save, discard };
}
