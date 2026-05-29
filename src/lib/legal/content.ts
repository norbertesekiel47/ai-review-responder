export interface LegalTable {
  headers: string[];
  rows: string[][];
}

export interface LegalSection {
  heading: string;
  body: string[];
  bullets?: string[];
  table?: LegalTable;
}

export interface LegalDoc {
  slug: 'terms' | 'privacy' | 'aup' | 'cookies' | 'sub-processors';
  title: string;
  version: string;
  effectiveDate: string;
  sections: LegalSection[];
}

const version = '2026-05-25';
const effectiveDate = '2026-05-25';

const subProcessorRows: string[][] = [
  ['OpenAI', 'AI draft generation', 'Review text, business context, generated responses'],
  ['Anthropic', 'AI draft fallback', 'Review text, business context, generated responses'],
  ['Stripe', 'Payments', 'Billing identifiers, name, email, address, subscription metadata'],
  ['Supabase', 'Database and auth', 'App data, auth metadata'],
  ['Vercel', 'Web hosting', 'Request metadata'],
  ['Railway', 'Worker hosting', 'Request metadata, job processing metadata'],
  ['Upstash', 'Redis cache and queues', 'Cache keys, job payload metadata'],
  ['Resend', 'Email', 'Email addresses, message content, delivery metadata'],
  ['Twilio', 'SMS and WhatsApp', 'Phone numbers, message content, delivery metadata'],
  ['Telegram', 'Bot delivery when enabled', 'Telegram identifiers, message content'],
  ['Zernio', 'Google review ingestion and posting', 'GBP OAuth tokens, review data, posting metadata'],
  ['Sentry', 'Error tracking', 'Scrubbed error metadata'],
  ['SerpAPI', 'Demo, prefill, and fallback location data', 'Public business and review data'],
  ['Google Maps Platform', 'Place autocomplete and map/place metadata', 'Place query metadata'],
];

const subProcessorTable: LegalTable = {
  headers: ['Vendor', 'Purpose', 'Data classes'],
  rows: subProcessorRows,
};

export const legalDocs: Record<LegalDoc['slug'], LegalDoc> = {
  terms: {
    slug: 'terms',
    title: 'Terms of Service',
    version,
    effectiveDate,
    sections: [
      {
        heading: 'Agreement',
        body: [
          'By creating an account or using RepWorth, you agree to these Terms. If you do not agree, do not use the Service.',
        ],
      },
      {
        heading: 'The Service',
        body: [
          'RepWorth monitors Google Business Profile reviews, generates AI-drafted response suggestions in your business voice, and delivers those drafts for owner approval by email, SMS, WhatsApp, Telegram, or other enabled product channels.',
          'No response is published to Google without explicit owner approval. You remain responsible for all content posted under your business accounts.',
        ],
      },
      {
        heading: 'Eligibility',
        body: [
          'You must be at least 18 years old and have authority to act on behalf of the business you register. You are responsible for keeping login credentials and approval links secure.',
        ],
      },
      {
        heading: 'Acceptable Use',
        body: [
          'You may not use RepWorth to generate misleading, defamatory, deceptive, unlawful, harassing, hateful, discriminatory, or privacy-invasive content. You may not use the Service to violate Google policies, third-party rights, or applicable law.',
          'We may suspend or terminate access, reject content, or disable publishing paths when we believe the Service is being misused.',
        ],
      },
      {
        heading: 'Subscription and Billing',
        body: [
          'Subscriptions are charged through Stripe. Prices are displayed at checkout and may change with advance notice. You may cancel according to the account-management workflow available in the product.',
          'Stripe handles payment card data. RepWorth stores billing identifiers and subscription state, not raw card numbers.',
        ],
      },
      {
        heading: 'Notifications',
        body: [
          'RepWorth may send service notifications when new reviews arrive, when drafts are ready for approval, when approval links are used, or when account action is required.',
          'If you provide a mobile phone number and opt in to SMS or WhatsApp notifications, you consent to receive recurring automated service messages from RepWorth. Consent is not a condition of purchase. Message frequency varies based on review volume. Message and data rates may apply.',
          'To opt out of SMS, reply STOP. For help, reply HELP or contact info@repworth.net. RepWorth does not share, sell, or rent mobile opt-in data or mobile numbers to third parties or affiliates for marketing or promotional purposes.',
        ],
      },
      {
        heading: 'AI-Generated Content',
        body: [
          'Response drafts are suggestions only. RepWorth does not warrant their accuracy, appropriateness, tone, completeness, or fitness for any purpose. You are responsible for reviewing all drafts before approving them for posting to Google.',
        ],
      },
      {
        heading: 'Data and Sub-processors',
        body: [
          'RepWorth uses sub-processors to operate the Service. Current sub-processors are OpenAI, Anthropic, Stripe, Supabase, Vercel, Railway, Upstash, Resend, Twilio, Telegram when enabled, Zernio, Sentry, SerpAPI, and Google Maps Platform.',
          'The current sub-processor list is mirrored in docs/legal/sub-processors.md and published at /legal/sub-processors.',
        ],
      },
      {
        heading: 'Intellectual Property',
        body: [
          'You retain ownership of your review data and response content. You grant RepWorth a limited, non-exclusive license to process that data solely to operate, secure, and improve the Service.',
        ],
      },
      {
        heading: 'Disclaimer of Warranties',
        body: [
          'The Service is provided "as is" without warranty of any kind, express or implied, including implied warranties of merchantability, fitness for a particular purpose, and non-infringement.',
        ],
      },
      {
        heading: 'Limitation of Liability',
        body: [
          'To the maximum extent permitted by applicable law, RepWorth\'s total liability for any claim arising out of or related to the Service is limited to the fees you paid in the three months preceding the claim. We are not liable for indirect, incidental, consequential, special, or punitive damages.',
        ],
      },
      {
        heading: 'Termination',
        body: [
          'Either party may terminate the agreement. We may suspend or terminate your account for cause immediately, or without cause with notice. Upon termination, access ends and data is handled according to the Privacy Policy and product retention workflows.',
        ],
      },
      {
        heading: 'Governing Law',
        body: [
          'These Terms are governed by the laws of the State of California, without regard to conflict-of-law principles. Disputes will be resolved in the courts of Los Angeles County, California, unless applicable law requires another forum.',
        ],
      },
      {
        heading: 'Changes to These Terms',
        body: [
          'We will notify registered users of material changes to these Terms when required. Continued use of the Service after an updated effective date constitutes acceptance of the updated Terms.',
        ],
      },
      {
        heading: 'Contact',
        body: ['RepWorth', 'Email: info@repworth.net', 'Website: repworth.net'],
      },
    ],
  },
  privacy: {
    slug: 'privacy',
    title: 'Privacy Policy',
    version,
    effectiveDate,
    sections: [
      {
        heading: 'Overview',
        body: [
          'RepWorth operates the RepWorth service. This policy describes what data we process, how we use it, and your rights.',
        ],
      },
      {
        heading: 'Data We Process',
        body: [],
        bullets: [
          'Account data: name, email address, phone number if provided, authentication metadata, and account preferences.',
          'Business profile data: business name, location data, Google Business Profile identifiers, and connected-account metadata.',
          'Review data: Google review text, reviewer display name, rating, review date, and source identifiers.',
          'Response data: AI-generated response drafts, edits, approvals, posting status, and audit metadata.',
          'Notification data: email addresses, phone numbers, Telegram identifiers when enabled, delivery metadata, and message content needed to provide service notifications.',
          'Billing data: Stripe customer, subscription, checkout, and invoice identifiers. RepWorth does not store raw card numbers.',
          'Reliability and service metadata: request metadata, logs, scrubbed error metadata, and service-operation metrics.',
        ],
      },
      {
        heading: 'How We Use Data',
        body: [],
        bullets: [
          'To monitor Google reviews and normalize review data.',
          'To generate AI response drafts for owner approval.',
          'To display, edit, approve, and publish approved responses.',
          'To send approval, notification, onboarding, and account emails.',
          'To send SMS, WhatsApp, or Telegram service notifications when enabled.',
          'To process subscription billing through Stripe.',
          'To secure the Service, prevent abuse, debug errors, and measure service-operation outcomes.',
        ],
      },
      {
        heading: 'AI Draft Generation',
        body: [
          'Review text and relevant business context may be sent to OpenAI or Anthropic to generate response drafts. Response drafts are not posted to Google without explicit owner approval.',
        ],
      },
      {
        heading: 'Sub-processors',
        body: ['This list intentionally excludes vendors without a live product data path.'],
        table: subProcessorTable,
      },
      {
        heading: 'SMS and Mobile Data',
        body: [
          'If you opt in to SMS or WhatsApp notifications, RepWorth uses your phone number solely to deliver service notifications and related account messages.',
          'Mobile opt-in data and mobile phone numbers are not shared, sold, rented, or disclosed to third parties or affiliates for marketing or promotional purposes.',
        ],
      },
      {
        heading: 'Cookies and Sessions',
        body: [
          'RepWorth uses necessary cookies for authentication, security, approval sessions, CSRF protection, and account preferences. See /legal/cookies.',
        ],
      },
      {
        heading: 'Security',
        body: [
          'Data is encrypted in transit. Approval tokens are stored as one-way SHA-256 hashes and never stored in plaintext. Browser code never receives service-role database credentials.',
          'No SOC 2, insurance, ZAP, Trivy, or Snyk completion claim is made by this policy.',
        ],
      },
      {
        heading: 'Retention',
        body: [
          'Account and review data is retained while your subscription is active and then deleted or anonymized according to product workflows and legal requirements. SMS opt-out and audit records may be retained as needed to honor compliance and security obligations.',
        ],
      },
      {
        heading: 'Your Rights',
        body: [
          'You may request access to, correction of, or deletion of your personal data, including mobile number and notification opt-in status, by emailing info@repworth.net.',
        ],
      },
      {
        heading: 'Changes to This Policy',
        body: [
          'We will notify registered users of material changes when required. Continued use of the Service after an updated effective date constitutes acceptance of the updated policy.',
        ],
      },
      {
        heading: 'Contact',
        body: ['RepWorth', 'Email: info@repworth.net', 'Website: repworth.net'],
      },
    ],
  },
  aup: {
    slug: 'aup',
    title: 'Acceptable Use Policy',
    version,
    effectiveDate,
    sections: [
      {
        heading: 'Prohibited Use',
        body: [
          'You may not use RepWorth to generate defamatory, deceptive, unlawful, harassing, hateful, discriminatory, or privacy-invasive content.',
          'You may not use RepWorth to impersonate others, mislead customers, manipulate reviews, or violate Google policies or applicable law.',
        ],
      },
      {
        heading: 'Review and Approval Responsibility',
        body: [
          'Owners are responsible for reviewing each draft before approval and for ensuring posted responses are accurate, lawful, and appropriate for their business.',
        ],
      },
      {
        heading: 'Enforcement',
        body: [
          'RepWorth may suspend or terminate access, reject content, or disable publishing paths when we believe the Service is being misused.',
        ],
      },
    ],
  },
  cookies: {
    slug: 'cookies',
    title: 'Cookie Policy',
    version,
    effectiveDate,
    sections: [
      {
        heading: 'Cookies',
        body: [
          'RepWorth uses necessary cookies for authentication, security, approval sessions, CSRF protection, and account preferences.',
          'These cookies are required for the Service to function and are not used to sell personal information.',
        ],
      },
      {
        heading: 'Analytics',
        body: [
          'RepWorth does not use browser analytics cookies. This policy and the sub-processor list will be updated before analytics cookies or a live analytics sub-processor are introduced.',
        ],
      },
      {
        heading: 'Managing Cookies',
        body: [
          'You can control cookies through your browser settings, but blocking necessary cookies may prevent login, approval, or account-management flows from working.',
        ],
      },
    ],
  },
  'sub-processors': {
    slug: 'sub-processors',
    title: 'Sub-processors',
    version,
    effectiveDate,
    sections: [
      {
        heading: 'Current Data Path',
        body: [
          'Current sub-processors are listed below. Vendors without a live product data path are not listed as current sub-processors.',
        ],
        table: subProcessorTable,
      },
    ],
  },
};
