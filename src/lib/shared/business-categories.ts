/**
 * The business-category vocabulary an owner picks from during onboarding
 * (#1093) — 15 groups, 92 subcategories.
 *
 * Lives in `shared/` rather than `onboarding/` because it is a DOMAIN
 * vocabulary with two unrelated consumers: the onboarding wizard renders it,
 * and `resolveVertical` (`src/lib/solicitation/restraint-policy.ts`) maps the
 * chosen subcategory to a solicitation vertical. Neither owns it.
 *
 * `as const` is load-bearing, not style. It is what gives `BusinessSubcategory`
 * a union of the 92 literals, which in turn makes
 * `SUBCATEGORY_VERTICALS` in `restraint-policy.ts` a TOTAL record: adding a
 * 93rd subcategory here without giving it a vertical is a COMPILE error, not a
 * silent fall to `other`. Before #1093 the mapping was keyword-guessed and 48
 * of these 92 fell to `other`, two of them wrongly.
 *
 * The stored value in `businesses.category` is the SUBCATEGORY string, never
 * the group. There is no `category_group` column and this file must not imply
 * one.
 */

export interface BusinessCategoryGroup {
  readonly category: string;
  readonly subcategories: readonly string[];
}

/** Rendered in listed order — `optgroup` per entry, `option` per subcategory. */
export const BUSINESS_CATEGORY_GROUPS = [
  {
    category: 'Food & Beverage',
    subcategories: [
      'Restaurants',
      'Cafes & Coffee Shops',
      'Bars & Nightclubs',
      'Bakeries',
      'Food Trucks',
      'Catering Services',
      'Breweries / Wineries / Distilleries',
    ],
  },
  {
    category: 'Hospitality & Travel',
    subcategories: [
      'Hotels & Resorts',
      'Bed & Breakfasts / Vacation Rentals',
      'Travel Agencies',
      'Tour Operators',
      'Event Venues',
    ],
  },
  {
    category: 'Health & Wellness',
    subcategories: [
      'Medical Practices (General / Specialist)',
      'Dental Practices',
      'Chiropractic Clinics',
      'Physical Therapy Clinics',
      'Mental Health / Counseling Services',
      'Optometry / Vision Care',
      'Veterinary Clinics',
      'Urgent Care / Walk-in Clinics',
      'Med Spas & Aesthetics',
      'Fitness Centers & Gyms',
      'Yoga / Pilates Studios',
      'Nutrition / Wellness Coaching',
    ],
  },
  {
    category: 'Beauty & Personal Care',
    subcategories: [
      'Hair Salons & Barbershops',
      'Nail Salons',
      'Spas',
      'Tattoo & Piercing Studios',
      'Skincare / Esthetics',
    ],
  },
  {
    category: 'Home Services',
    subcategories: [
      'Plumbing',
      'Electrical',
      'HVAC',
      'Landscaping & Lawn Care',
      'Cleaning Services (Residential / Commercial)',
      'Pest Control',
      'Roofing',
      'General Contracting / Remodeling',
      'Painting',
      'Moving & Storage',
      'Handyman Services',
      'Pool Services',
    ],
  },
  {
    category: 'Automotive',
    subcategories: [
      'Auto Repair & Maintenance',
      'Car Dealerships (New / Used)',
      'Auto Detailing',
      'Auto Body Shops',
      'Tire Shops',
      'Car Rental',
    ],
  },
  {
    category: 'Professional Services',
    subcategories: [
      'Law Firms',
      'Accounting / Tax Services',
      'Financial Advisory / Wealth Management',
      'Insurance Agencies',
      'Real Estate Agencies',
      'Property Management',
      'Marketing / Advertising Agencies',
      'IT Services / Consulting',
      'Staffing / Recruiting Agencies',
    ],
  },
  {
    category: 'Retail',
    subcategories: [
      'Clothing & Apparel',
      'Furniture & Home Goods',
      'Electronics',
      'Grocery / Specialty Food Stores',
      'Jewelry Stores',
      'Pet Stores',
      'Sporting Goods',
      'Bookstores',
      'General / Department Stores',
    ],
  },
  {
    category: 'Education & Childcare',
    subcategories: [
      'Daycare / Preschool',
      'Tutoring Services',
      'Music / Art Lessons',
      'Driving Schools',
      'Vocational / Trade Schools',
      'Higher Education',
    ],
  },
  {
    category: 'Entertainment & Recreation',
    subcategories: [
      'Movie Theaters',
      'Amusement / Family Entertainment Centers',
      'Bowling Alleys',
      'Escape Rooms',
      'Golf Courses / Country Clubs',
      'Museums / Attractions',
    ],
  },
  {
    category: 'Construction & Industrial',
    subcategories: [
      'General Contractors',
      'Specialty Trades (Concrete, Masonry, etc.)',
      'Equipment Rental',
      'Manufacturing',
    ],
  },
  {
    category: 'Financial & Legal',
    subcategories: [
      'Banks / Credit Unions',
      'Mortgage Brokers',
    ],
  },
  {
    category: 'E-commerce & Technology',
    subcategories: [
      'Online Retailers',
      'SaaS / Software Companies',
      'App-based Services',
    ],
  },
  {
    category: 'Other Services',
    subcategories: [
      'Photography / Videography',
      'Wedding / Event Planning',
      'Funeral Homes',
      'Storage Facilities',
      'Non-Profit Organizations',
    ],
  },
  {
    category: 'Other',
    subcategories: [
      'Not Listed (please specify)',
    ],
  },
] as const;

/** The 92 subcategory literals. The union `SUBCATEGORY_VERTICALS` must cover. */
export type BusinessSubcategory =
  (typeof BUSINESS_CATEGORY_GROUPS)[number]['subcategories'][number];

/** Flat list, in render order. */
export const BUSINESS_SUBCATEGORIES: readonly BusinessSubcategory[] =
  BUSINESS_CATEGORY_GROUPS.flatMap((group) => group.subcategories);

/** Whether a stored `businesses.category` is one of the 92. A legacy row holds
 *  free text and is NOT — that is a legal state, deliberately: #1085 chose a
 *  keyword fallback over a migration. */
export function isBusinessSubcategory(value: string): value is BusinessSubcategory {
  return (BUSINESS_SUBCATEGORIES as readonly string[]).includes(value);
}

/**
 * Best-effort match of an EXTERNAL category string onto the vocabulary, for the
 * Google Maps prefill boundary (#1093).
 *
 * Case- and whitespace-insensitive EXACT match only. Deliberately not fuzzy:
 * the defect this whole change replaces was a fuzzy matcher quietly picking the
 * wrong answer, and pre-selecting a wrong category is worse than pre-selecting
 * none — the owner may never look at a field that already appears filled in.
 *
 * `null` means "leave the select empty and let the owner choose", which is the
 * common case: Google's category taxonomy is not ours.
 */
export function matchSubcategory(value: string | null): BusinessSubcategory | null {
  if (value === null) return null;
  const needle = value.trim().toLowerCase();
  if (needle.length === 0) return null;
  return (
    BUSINESS_SUBCATEGORIES.find((sub) => sub.toLowerCase() === needle) ?? null
  );
}
