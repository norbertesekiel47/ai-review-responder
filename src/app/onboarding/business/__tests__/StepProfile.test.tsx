// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { StepProfile } from '../StepProfile';
import type { WizardFormData } from '../BusinessWizardClient';
import {
  BUSINESS_CATEGORY_GROUPS,
  BUSINESS_SUBCATEGORIES,
} from '@/lib/shared/business-categories';
import { buildBusinessWizardPayload } from '../payload';

const baseData: WizardFormData = {
  inputMode: 'autocomplete',
  googlePlaceId: '',
  googlePlaceAddress: '',
  googleMapsUrl: '',
  businessName: 'Test Biz',
  category: '',
  website: '',
  tone: '',
  productsServices: '',
  staffNames: '',
  highlightFacts: '',
  avoidFacts: '',
  sampleResponses: '',
};

function makeDirtyRef() {
  return { current: { category: false, website: false } };
}

describe('StepProfile', () => {
  it('hides the Back button when no onBack is provided (demo-flow first step)', () => {
    render(
      <StepProfile
        stepLabel="Step 1 of 3 — Profile"
        data={baseData}
        update={vi.fn()}
        dirtyRef={makeDirtyRef()}
        onNext={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
    expect(
      screen.getByRole('button', { name: /continue/i }),
    ).toBeInTheDocument();
  });

  it('shows a working Back button when onBack is provided', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <StepProfile
        stepLabel="Step 1 of 3 — Profile"
        data={baseData}
        update={vi.fn()}
        dirtyRef={makeDirtyRef()}
        onNext={vi.fn()}
        onBack={onBack}
      />,
    );
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

// #1093. Category was a free-text input; it is now a closed 92-item vocabulary,
// because `resolveVertical` maps the stored value to a solicitation vertical and
// a vertical picks a freshness window. Free text made that a keyword guess.
describe('StepProfile — category vocabulary', () => {
  function renderProfile(overrides: Partial<WizardFormData> = {}, update = vi.fn()) {
    render(
      <StepProfile
        stepLabel="Step 1 of 3 — Profile"
        data={{ ...baseData, ...overrides }}
        update={update}
        dirtyRef={makeDirtyRef()}
        onNext={vi.fn()}
      />,
    );
    return update;
  }

  it('the category select renders all 15 groups and 92 subcategories', () => {
    renderProfile();
    const select = screen.getByLabelText('Category');
    expect(select.tagName).toBe('SELECT');
    expect(select.querySelectorAll('optgroup')).toHaveLength(BUSINESS_CATEGORY_GROUPS.length);
    // 92 subcategories + the "Choose a category…" placeholder.
    expect(select.querySelectorAll('option')).toHaveLength(BUSINESS_SUBCATEGORIES.length + 1);
  });

  it('groups each subcategory under its own optgroup label', () => {
    renderProfile();
    // Read the `label` PROPERTY rather than an attribute selector: several
    // group names carry an `&`, which a CSS attribute selector will not match
    // reliably across engines.
    const optgroups = Array.from(
      screen.getByLabelText('Category').querySelectorAll('optgroup'),
    );
    for (const group of BUSINESS_CATEGORY_GROUPS) {
      const match = optgroups.find((node) => node.label === group.category);
      expect(match, `${group.category} has no optgroup`).toBeDefined();
      expect(match!.querySelectorAll('option')).toHaveLength(group.subcategories.length);
    }
  });

  it('choosing a subcategory stores that exact string in the onboarding payload', async () => {
    const update = renderProfile();
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'Cafes & Coffee Shops');
    expect(update).toHaveBeenCalledWith({ category: 'Cafes & Coffee Shops' });

    // …and the payload builder passes it through unchanged. The stored value is
    // the SUBCATEGORY, never the group — there is no category_group column.
    const payload = buildBusinessWizardPayload(
      { ...baseData, category: 'Cafes & Coffee Shops' },
      { demoFlowEnabled: true },
    );
    expect(payload.category).toBe('Cafes & Coffee Shops');
  });

  it('marks the category dirty so a later place prefill cannot overwrite it', async () => {
    const dirtyRef = makeDirtyRef();
    render(
      <StepProfile
        stepLabel="Step 1 of 3 — Profile"
        data={baseData}
        update={vi.fn()}
        dirtyRef={dirtyRef}
        onNext={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'Restaurants');
    expect(dirtyRef.current.category).toBe(true);
  });

  it('starts on the placeholder, and Category stays optional', () => {
    renderProfile();
    expect(screen.getByLabelText('Category')).toHaveValue('');
    // `canContinue` depends on businessName alone; making Category required is
    // a product decision nobody has taken.
    expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled();
  });

  it('offers a pre-vocabulary stored value back rather than dropping it', () => {
    // #1085 kept legacy free-text categories legal instead of migrating them.
    // A returning owner whose row predates the vocabulary must not have it
    // silently cleared the next time they save this step.
    renderProfile({ category: "Bella's Cafe" });
    const select = screen.getByLabelText('Category');
    expect(select).toHaveValue("Bella's Cafe");
    expect(select.querySelector('option[value="Bella\'s Cafe"]')).not.toBeNull();
  });

  it('does not add a legacy option when the stored value is in the vocabulary', () => {
    renderProfile({ category: 'Restaurants' });
    const select = screen.getByLabelText('Category');
    expect(select).toHaveValue('Restaurants');
    expect(select.querySelectorAll('option')).toHaveLength(BUSINESS_SUBCATEGORIES.length + 1);
  });
});

