'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DashboardData, DashboardDataActive, DashboardSettings } from '@/lib/dashboard/types';

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

export function settingsRedirectForDashboardData(json: DashboardData): string | null {
  if (json.subscriptionStatus === 'pending_payment') return json.paymentUrl ?? '/dashboard';
  if (
    json.subscriptionStatus === 'active_pending_business' ||
    json.subscriptionStatus === 'pending_payment_admin_handoff'
  ) {
    return '/dashboard';
  }
  return null;
}

export interface UseSettingsForm {
  data: DashboardDataActive | null;
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
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [initial, setInitial] = useState<SettingsForm | null>(null);
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

  const query = useQuery<DashboardData>({
    queryKey: ['dashboard-settings'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      return res.json() as Promise<DashboardData>;
    },
  });

  const redirectUrl = query.data ? settingsRedirectForDashboardData(query.data) : null;
  // Statuses that redirect away from settings never expose active data; mirror
  // the original effect, which only set `data` when no redirect applied.
  const data: DashboardDataActive | null =
    query.data && !redirectUrl ? (query.data as DashboardDataActive) : null;
  const fetchError = query.error ? query.error.message : null;

  // The redirect is a genuine browser side effect, so it stays in an effect
  // keyed off the resolved URL (runs once per distinct redirect target).
  useEffect(() => {
    if (redirectUrl) window.location.href = redirectUrl;
  }, [redirectUrl]);

  // Seed editable form state from fetched data during render via the
  // store-previous-value pattern, so no initialization effect remains.
  const seededRef = useRef<DashboardDataActive | null>(null);
  if (data && data !== seededRef.current) {
    seededRef.current = data;
    const f = settingsToForm(data.settings);
    setForm(f);
    setInitial(f);
  }

  const dirty = useMemo(() => {
    if (!form || !initial) return false;
    return buildPatch(initial, form) !== null;
  }, [form, initial]);

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
