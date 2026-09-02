'use client';

// Step 2 — Google Business info. Informational only: the connect flow runs
// right AFTER the wizard submits (useAddLocationWizard navigates to the new
// location's connect route), never from inside it. There is no
// link out of here — a live Connect link mid-wizard exited the flow and threw
// away every field the owner had filled in (UX audit D23) — and no button of
// its own: the shell's Continue is the one way forward.

import { Icon } from '@/components/dashboard/shell/Icon';

export function Step2GoogleBusiness() {
  return (
    <div className="wizard-panel">
      <h2 className="wizard-title">Google Business Profile</h2>
      <p className="wizard-desc">
        Once this location is added, we&apos;ll take you straight to connect
        its Google Business Profile so RepWorth can import its reviews and
        publish the replies you approve.
      </p>

      <div className="wizard-info-box" style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <Icon name="google" size={20} />
          <div>
            <p style={{ fontWeight: 500, marginBottom: 4 }}>
              Connecting comes right after this
            </p>
            <p style={{ color: 'var(--rw-app-text-muted)', fontSize: 14 }}>
              Nothing to do on this step. If you skip the Google connection
              when it comes up, you can always finish it later from
              Settings → Locations.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
