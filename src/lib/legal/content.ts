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

// Publication date must be confirmed with the legal review in docs/legal/legal-review.md.
const version = '2026-09-16';
const effectiveDate = '2026-09-16';

const LEGAL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * Renders an ISO `YYYY-MM-DD` legal date the way a reader says it — "9 June 2026".
 * Split by hand rather than via `Date`, so the day never shifts with the
 * server's time zone. Anything that is not `YYYY-MM-DD` comes back unchanged.
 */
export function formatLegalDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  const monthName = LEGAL_MONTHS[Number(month) - 1];
  if (!monthName) return isoDate;
  return `${Number(day)} ${monthName} ${year}`;
}

const subProcessorRows: string[][] = [
  ['OpenAI', 'AI replies, summaries, classification, safety checks, and enabled assistant features', 'Review and response text, relevant business context, and prompts or conversations for the feature used'],
  ['Anthropic', 'AI processing, including fallback when configured', 'Review and response text, relevant business context, and prompts or conversations for the feature used'],
  ['Stripe', 'Payments', 'Billing identifiers, name, email, address, subscription metadata'],
  ['Supabase', 'Database, authentication, and storage', 'Account, business, review, response, contact, consent, and authentication data'],
  ['Vercel', 'Web hosting and bot protection', 'Requests, IP/device metadata, and application data handled by the web service'],
  ['Railway', 'Worker hosting and Redis job queues', 'Application data and job payloads needed for processing and delivery'],
  ['Upstash', 'Redis cache, rate limits, and usage controls', 'Cache entries, identifiers, counters, and operational metadata'],
  ['Resend', 'Email', 'Email addresses, message content, delivery metadata'],
  ['Twilio', 'WhatsApp delivery when enabled', 'Phone numbers, message content, consent and delivery metadata'],
  ['Meta / WhatsApp', 'WhatsApp messaging platform when enabled', 'Phone numbers, message content, and messaging metadata'],
  ['Telegram', 'Bot delivery when enabled', 'Telegram identifiers, message content'],
  ['Zernio', 'Google review ingestion and posting', 'GBP OAuth tokens, review data, posting metadata'],
  ['Sentry', 'Error and performance monitoring', 'Scrubbed diagnostics, request and device metadata, and performance events'],
  ['PostHog', 'Server-dispatched product analytics when configured', 'Pseudonymous visitor/account identifiers, usage events, timestamps, and filtered event properties'],
  ['SerpAPI', 'Public business/review lookup, demos, and enabled ranking or competitor features', 'Business identifiers, search/location queries, and public business and review data'],
  ['Google Maps Platform', 'Place autocomplete and map/place metadata', 'Place query metadata'],
  ['Google Business Profile', 'Connected review source and destination for authorized replies', 'Connected-account permissions, location/review data, and published responses'],
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
          'These Terms govern the RepWorth website and business reputation-management service (the Service), operated by REPWORTH, INC., a Delaware corporation (RepWorth, we, us). By accepting these Terms or using the Service, you agree to them on behalf of yourself and the business you represent. If you do not agree, do not use the Service.',
          'Our Acceptable Use Policy at /legal/aup forms part of these Terms. Our Privacy Policy at /legal/privacy explains our data practices. An order or separately signed agreement controls if it expressly overrides a conflicting provision of these Terms.',
        ],
      },
      {
        heading: 'The Service',
        body: [
          'RepWorth helps businesses monitor Google Business Profile reviews, draft and manage replies, identify issues, and understand review trends. Depending on your plan and enabled features, the Service may also support multiple locations, review requests, ranking or competitor insights, and an AI assistant for proposed settings changes.',
          'Copilot requires your approval before a reply is posted. Where Autopilot is available and you expressly enable an auto-reply policy, eligible replies may be published under that policy without individual approval, subject to the limits and waiting period shown in the product. An Autopilot subscription alone does not authorize automatic posting. You may change or disable the policy and use available controls to stop a pending action; stopping automation does not retract content already published.',
          'You authorize only the connected locations and actions you select. You remain responsible for your instructions, automation settings, and content published under your business accounts. Automated checks reduce risk but cannot guarantee that every error or unsuitable reply will be detected.',
          'Feature availability depends on your plan, account configuration, rollout, and third-party availability. A description of an optional or beta feature is not a promise that it is enabled for your account. The Service is not an emergency-monitoring service and does not guarantee review removal, a particular rating, search ranking, revenue, or uninterrupted delivery.',
        ],
      },
      {
        heading: 'Eligibility',
        body: [
          'You must be at least 18 years old and have authority to act on behalf of the business you register. You are responsible for keeping login credentials and approval links secure.',
          'Provide accurate account and billing information, manage access by your authorized users, and promptly report suspected unauthorized access to security@repworth.net. Do not connect a business profile you are not authorized to manage.',
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
          'Subscriptions are charged through Stripe and renew automatically for the billing interval shown at checkout until cancelled. By subscribing, you authorize recurring charges at the disclosed price, including disclosed location charges and applicable taxes. Your checkout or order identifies your plan, included locations, billing interval, and any promotion.',
          'If a trial or promotional period is offered, its duration, eligibility, and subsequent price are shown when you enroll. Unless the offer says otherwise, a trial requiring a payment method converts to a paid subscription when it ends unless you cancel first. Price changes apply prospectively after advance notice and any consent required by law; you can cancel before a new price takes effect.',
          'You can request cancellation through the account-management controls in Settings when available, or by contacting support@repworth.net. If an account control is unavailable, contact support for help. Disconnecting Google, opting out of messages, or ceasing use does not by itself cancel billing. You remain responsible for valid charges incurred before cancellation takes effect.',
          'RepWorth offers two ways to end a subscription. Standard cancellation keeps your access and posting paths active through the end of the current paid billing period and then ends the subscription; no further subscription renewals are charged, and the unused portion of the current period is not refunded except where required by law or your written agreement. Immediate account deletion stops review processing and draft generation, starts teardown of billing and Google connections, and schedules permanent deletion of your data.',
          'If you request immediate account deletion in the middle of a paid billing period, you forfeit the remaining paid time, and any prepaid or unused fees for that period are non-refundable except where a refund is required by applicable law or your written agreement. RepWorth does not provide a self-serve data export before deletion. Save information available to you and contact support about access or portability requests before confirming deletion.',
          'Stripe handles payment card data. RepWorth stores billing identifiers and subscription state, not raw card numbers.',
        ],
      },
      {
        heading: 'Notifications',
        body: [
          'RepWorth may send service notifications when new reviews arrive, when drafts are ready for approval, when approval links are used, or when account action is required.',
          'If you provide a mobile phone number and opt in to WhatsApp notifications, you consent to receive recurring automated service messages from RepWorth. Consent is not a condition of purchase. Message frequency varies based on review volume. Message and data rates may apply.',
          'To opt out of WhatsApp, reply STOP or use the available channel settings. For help, contact support@repworth.net. You can disable Telegram notifications through channel settings or stop the bot. Disabling a notification channel does not cancel your subscription or disable an auto-reply policy.',
          'RepWorth does not share, sell, or rent mobile opt-in data or mobile numbers to third parties or affiliates for their marketing or promotional purposes. Messaging providers process this information as needed to deliver the messages you request. Service messages are separate from any optional marketing communications.',
        ],
      },
      {
        heading: 'AI-Generated Content',
        body: [
          'Response drafts are suggestions only. AI can produce inaccurate, incomplete, biased, or inappropriate content, and similar output may be generated for others. Review drafts before approving them. If you enable Autopilot, assess its scope and monitor the resulting replies. AI output is not legal, medical, financial, or other professional advice.',
          'Do not instruct the Service to invent facts, customer experiences, promises, discounts, or admissions of liability. An assistant suggestion does not itself authorize a settings change; use the confirmation controls required by the product.',
        ],
      },
      {
        heading: 'Review Requests and Customer Contacts',
        body: [
          'If review-request features are enabled, you are responsible for the contact information you upload, the purpose of each message, the required notices and permissions, and any applicable consent records. Only contact people you are permitted to contact through the selected channel. Provide an accurate sender identity and valid postal address when required, honor opt-outs, and keep suppression records accurate.',
          'Do not upload purchased or scraped contact lists, send unsolicited bulk messages, offer incentives for Google reviews, fabricate reviews, or selectively request public reviews only from customers expected to be positive. Do not use threats or improper pressure to suppress negative feedback. Product eligibility and suppression checks do not replace your legal obligations.',
        ],
      },
      {
        heading: 'Connected Platforms',
        body: [
          'Google, messaging services, and other connected platforms have their own terms, content rules, and privacy practices. You authorize RepWorth and its connection provider to access the data and perform the actions needed for features you enable. You can disconnect through the product or revoke the relevant connection in your Google account; contact support if you need help.',
          'RepWorth is independent of Google and is not endorsed by Google. Third parties may reject or remove content, change their APIs, or suspend connections. Disconnecting or deleting a RepWorth account does not automatically remove reviews or replies already published on Google.',
        ],
      },
      {
        heading: 'Data and Sub-processors',
        body: [
          'RepWorth uses service providers and connected platforms described at /legal/sub-processors. Our Privacy Policy explains what data they may receive. Where a data processing agreement is required for your use, arrange it with us before submitting the covered data; a provider list is not a substitute for an executed agreement.',
          'Do not submit passwords, payment card details, government identification numbers, private health records, or other sensitive information in review replies, contact notes, or assistant messages. Do not use the Service to process protected health information requiring a HIPAA business associate agreement unless we have expressly agreed in writing and executed that agreement.',
        ],
      },
      {
        heading: 'Intellectual Property',
        body: [
          'You retain rights you hold in the content you provide. Reviewers, Google, and other rights holders retain their rights; connecting a profile does not transfer ownership of third-party reviews to you or to RepWorth. You represent that you have the permissions needed to provide data and instructions to the Service.',
          'You grant RepWorth a non-exclusive license to host, copy, process, transmit, and display your content only as needed to provide and secure the Service, follow your authorized instructions, and comply with law, as described in our Privacy Policy and any applicable data processing agreement. This is not permission to sell your content or train a general-purpose AI model on it.',
          'As between you and RepWorth, you may use the generated replies provided to you, subject to third-party rights and applicable law. We do not guarantee that AI output is unique or eligible for copyright protection. RepWorth retains its rights in its software, branding, and documentation and grants you a limited right to use the Service during your authorized subscription.',
        ],
      },
      {
        heading: 'Disclaimer of Warranties',
        body: [
          'To the extent permitted by law, the Service is provided "as is" and "as available" without warranties of merchantability, fitness for a particular purpose, or non-infringement. Nothing in these Terms excludes a warranty or right that cannot lawfully be excluded.',
        ],
      },
      {
        heading: 'Limitation of Liability',
        body: [
          'To the maximum extent permitted by applicable law, RepWorth\'s total liability for any claim arising out of or related to the Service is limited to the fees you paid in the three months preceding the claim. We are not liable for indirect, incidental, consequential, special, or punitive damages.',
          'These exclusions and limits do not apply to fraud, willful misconduct, or liability that applicable law does not allow us to exclude or limit. Any non-waivable statutory rights remain available.',
        ],
      },
      {
        heading: 'Termination',
        body: [
          'Either party may terminate the agreement. We may suspend or terminate your account for cause immediately, or without cause with notice. Upon termination, access ends and data is handled according to the Privacy Policy and product retention workflows.',
          'When you request account deletion, RepWorth schedules a 30-day waiting period before its permanent purge workflow, while processing is stopped and connected services are torn down. Provider cleanup or failures may take additional time. RepWorth deletes or anonymizes customer data while retaining limited billing, security, and compliance records where required or permitted by law. RepWorth does not promise absolute deletion of every record, including records retained independently by payment or messaging providers.',
          'Standard cancellation is not an account-deletion request; retained information may remain for reactivation, recordkeeping, or other purposes described in our Privacy Policy. Provisions that by their nature should survive termination, including payment obligations, intellectual property, disclaimers, and liability limits, survive.',
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
          'We will give notice of material changes through the Service or your account email, stating when they take effect and obtaining consent where required. Changes do not retroactively alter accrued rights. Where permitted by law, continued use after the notified effective date constitutes acceptance; if you disagree, stop using the Service and cancel your subscription.',
        ],
      },
      {
        heading: 'Contact',
        body: ['REPWORTH, INC., a Delaware corporation', 'Email: support@repworth.net', 'Website: repworth.net'],
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
          'REPWORTH, INC., a Delaware corporation, operates the RepWorth website and business reputation-management service. This policy covers visitors, account users, business contacts, and individuals whose information is processed through our features.',
          'We determine how account, billing, support, security, and website information is used. For customer-provided contacts and business review workflows, we generally process information on the business customer\'s instructions. That business is responsible for its own privacy notice and lawful use of the information. A person may have rights even if they do not have a RepWorth account.',
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
          'Customer contact data, when review-request features are used: names, email addresses, phone numbers, visit dates, uploaded notes, consent evidence, delivery results, and opt-out or suppression records.',
          'AI and automation data, when enabled: assistant messages, relevant business context, proposed and applied settings, automation policies, decisions, summaries, and action records.',
          'Notification data: email addresses, phone numbers, Telegram identifiers when enabled, delivery metadata, and message content needed to provide service notifications.',
          'Billing data: Stripe customer, subscription, checkout, and invoice identifiers. RepWorth does not store raw card numbers.',
          'Reliability and service metadata: IP address, browser/device and request metadata, cookies and pseudonymous identifiers, timestamps, usage events, logs, scrubbed diagnostics, and service-operation metrics.',
          'Support and inquiry data: information you provide through contact forms, demo requests, feedback, and support correspondence.',
        ],
      },
      {
        heading: 'Sources of Information',
        body: [
          'We receive information from you, your business and its authorized users, connected Google accounts through Zernio, public business and review sources, payment and messaging providers, and your browser or device. Optional features only process their associated information when used or enabled. Public availability does not eliminate all privacy or platform restrictions.',
        ],
      },
      {
        heading: 'How We Use Data',
        body: [],
        bullets: [
          'To monitor Google reviews and normalize review data.',
          'To generate AI response drafts for owner approval.',
          'To display, edit, and publish responses after your approval or under an expressly enabled Autopilot policy.',
          'To provide enabled summaries, triage, automation controls, assistant conversations, and business insights.',
          'To deliver authorized review requests and record consent, delivery, and opt-outs when those features are enabled.',
          'To send approval, notification, onboarding, and account emails.',
          'To send WhatsApp or Telegram service notifications when enabled.',
          'To process subscription billing through Stripe.',
          'To secure the Service, prevent abuse, debug errors, and measure service-operation outcomes.',
        ],
      },
      {
        heading: 'AI Draft Generation',
        body: [
          'Review text, responses, and relevant business context may be sent to OpenAI or Anthropic for draft generation, summaries, classification, safety checks, and other enabled AI features. If you use the assistant, its messages and relevant account context may also be processed by those providers. Only provide information appropriate for the task.',
          'Copilot replies require individual approval. Where available, an expressly enabled Autopilot policy can authorize eligible replies without individual approval, subject to the controls shown in the product. Automated checks may make mistakes.',
          'RepWorth does not use customer content to train a general-purpose AI model. We use commercial AI APIs; provider retention, abuse-monitoring, and data handling are governed by the applicable provider agreements and settings. This is not a promise of zero provider retention.',
        ],
      },
      {
        heading: 'Google Account Information',
        body: [
          'When you connect Google Business Profile, our connection provider Zernio handles the authorization needed to retrieve authorized location and review information and publish authorized replies. We process connected-account identifiers, connection status, review data, and response records for the features you use. We do not request your Google password.',
          'You can revoke the relevant third-party connection in your Google account or disconnect in RepWorth. Revocation stops future authorized access but does not itself cancel your subscription, delete retained records, or remove replies already published. Contact support@repworth.net to request deletion.',
        ],
      },
      {
        heading: 'Sub-processors',
        body: ['The providers below support our implemented data flows. Optional providers receive data only when their features and integrations are used or configured. Some connected platforms and payment providers also act independently under their own privacy policies; not every listed company acts solely as our sub-processor.'],
        table: subProcessorTable,
      },
      {
        heading: 'Other Disclosures',
        body: [
          'We disclose information to authorized account users, to connected platforms when you direct an action, and to providers needed to operate the Service. An approved or policy-authorized reply sent to Google becomes public. A message sent through email, WhatsApp, or Telegram is handled by that channel and its providers.',
          'We may disclose information where legally required, to protect rights and investigate misuse, or in a business transaction subject to applicable confidentiality and data-protection requirements. Additional restrictions on connected-platform information continue to apply.',
          'RepWorth does not sell personal information or share it for cross-context behavioral advertising. We do not use customer contact lists or mobile opt-in information for other companies\' marketing.',
        ],
      },
      {
        heading: 'Mobile Data',
        body: [
          'If you opt in to WhatsApp notifications, RepWorth uses your phone number and consent information to deliver service notifications and related account messages through Twilio and WhatsApp. Telegram identifiers are used for the bot notifications you enable. Providers receive message content and delivery information needed for those services.',
          'Mobile opt-in data and mobile phone numbers are not shared, sold, rented, or disclosed to third parties or affiliates for their marketing or promotional purposes. Reply STOP to opt out of WhatsApp, or use the available channel controls. For help, email support@repworth.net.',
        ],
      },
      {
        heading: 'Cookies and Sessions',
        body: [
          'We use authentication, security, approval-session, and preference storage. The product analytics endpoint also sets a first-party pseudonymous cookie, rw_analytics_id, for up to one year and may renew it on later events. Server-side dispatch to PostHog does not make this cookie necessary or eliminate applicable consent requirements. See /legal/cookies for storage purposes and controls.',
          'We use filtered usage events to understand onboarding and product operation. PostHog receives these events when configured. Our Sentry configuration disables session replay. We do not currently interpret a browser Do Not Track signal as a separate product setting. We do not sell or share personal information for cross-context advertising, and Global Privacy Control does not currently change that practice.',
        ],
      },
      {
        heading: 'Security',
        body: [
          'We use encrypted transport, access controls scoped to accounts and locations, and hashed approval-token records. Raw approval links must be delivered to their recipients, so protect them like credentials. Access by authorized personnel may be needed for support, security, and service operation.',
          'No service can guarantee absolute security. Our public security page at /security describes selected safeguards; it is not a certification, HIPAA compliance claim, or guarantee that sensitive information will always be detected.',
        ],
      },
      {
        heading: 'Retention',
        body: [
          'Retention depends on the information, feature, customer instructions, legal obligations, platform restrictions, and the need to resolve disputes or maintain security. Subscription cancellation does not automatically delete account or review records. You can separately request account deletion or exercise your privacy rights.',
          'The account-deletion workflow schedules permanent purging after a 30-day waiting period. Processing is stopped earlier while billing and connected services are torn down. Cleanup failures or provider handling can delay completion; this is not a promise that every copy disappears on day 30. Limited consent, suppression, billing, security, and legal records may be retained where necessary. Backups and independent provider records may follow separate retention cycles.',
          'Our payment-provider cleanup redacts the Stripe customer record and detaches saved payment methods, but does not erase all provider records. Retained records can include paid invoices with their original billing name and address, tax identifiers, and detached payment-method records with billing contact details and the last four digits of the card. The payment processor handles its own retention for financial recordkeeping, tax, fraud prevention, and legal obligations.',
        ],
      },
      {
        heading: 'Your Rights',
        body: [
          'Email support@repworth.net to request access, correction, deletion, or a copy of your personal information, or to ask about our processing. Include enough context to locate your information, such as the account email or the business that contacted you; do not send passwords or full payment details. We may proportionately verify your identity or an authorized agent\'s authority before acting.',
          'Depending on your location and the law applicable to the processing, you may also have rights to portability, restriction, objection, withdrawal of consent, an appeal of a denied request, or a complaint to a privacy regulator. Where an appeal right applies, reply to our decision or email support with the subject Privacy appeal. We respond within applicable legal deadlines and do not unlawfully discriminate for exercising rights. Exceptions may apply, including required recordkeeping and other people\'s rights.',
          'For data processed on a business customer\'s instructions, we may refer the request to that business or assist it in responding. Review-request recipients may also use the message\'s unsubscribe mechanism. Unsubscribing does not require a RepWorth account. Deleting information from RepWorth does not remove an original Google review; use Google\'s controls for that request.',
        ],
      },
      {
        heading: 'International Processing and Legal Bases',
        body: [
          'We and our providers may process information in the United States and other countries, which may have different privacy laws. Where a transfer safeguard is legally required, it must be in place for the relevant processing. Contact support@repworth.net for information about the arrangements applicable to your account; this policy does not itself establish a transfer agreement or claim participation in a certification framework.',
          'Where European or UK data-protection law applies to processing for which we are responsible, the relevant legal basis may be performing a contract with you, our legitimate interests in providing and securing the Service and responding to inquiries, compliance with legal obligations, or consent where required. Business customers determine the legal basis for their instructions. You may withdraw consent without affecting the lawfulness of earlier processing.',
        ],
      },
      {
        heading: 'Children and Sensitive Information',
        body: [
          'The Service is intended for adult business users and is not directed to children under 13. We do not knowingly collect account information from children under 13. Contact us if you believe a child has provided information so we can investigate and take appropriate action.',
          'Do not upload private health records or other sensitive information not needed for reputation management. Automated filtering is limited and does not make the Service suitable for protected health information or replace a required business associate agreement.',
        ],
      },
      {
        heading: 'Changes to This Policy',
        body: [
          'We will update the effective date and provide notice of material changes as required, including obtaining fresh consent where required for a new use of information. A privacy notice describes our practices; continued use alone is not consent to processing that legally requires affirmative consent.',
        ],
      },
      {
        heading: 'Contact',
        body: ['REPWORTH, INC., a Delaware corporation', 'Privacy requests: support@repworth.net', 'Security reports: security@repworth.net', 'Website: repworth.net'],
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
          'Do not create fake customer reviews or experiences, buy reviews, offer incentives for Google reviews, conceal material relationships, or threaten people to remove or change legitimate reviews. Do not route only likely satisfied customers to public reviews while diverting dissatisfied customers to private feedback.',
          'Do not send spam, use purchased or scraped contact lists, falsify consent, override opt-outs, or re-import suppressed contacts to evade a restriction. Supply a valid sender identity and postal address when required for review requests.',
          'Do not submit private health records, payment card details, passwords, government identification numbers, or unnecessary sensitive information. Do not reveal a reviewer\'s private customer or patient relationship in a public reply.',
          'Do not attempt unauthorized access, introduce malware, disrupt the Service, evade usage or safety limits, or use another business\'s connected profile without authority. Good-faith vulnerability reports should follow /security.',
        ],
      },
      {
        heading: 'Review and Approval Responsibility',
        body: [
          'Owners are responsible for reviewing each draft before approval and for ensuring posted responses are accurate, lawful, and appropriate for their business. If you expressly enable Autopilot, you must choose an appropriate policy, monitor published replies, and pause or narrow automation when needed. Subscription purchase or a connected profile alone does not authorize all automated actions.',
          'Only use review-request features with a lawful basis and any required channel consent. Keep supporting records and honor withdrawals. RepWorth\'s screening and suppression controls do not guarantee compliance or replace your own obligations.',
        ],
      },
      {
        heading: 'Enforcement',
        body: [
          'RepWorth may suspend or terminate access, reject content, or disable publishing paths when we believe the Service is being misused.',
          'We may preserve relevant records where permitted or required by law and give notice when appropriate, except where doing so would create a security or legal risk. Report suspected misuse or request review of a restriction at support@repworth.net. This policy does not restrict lawful criticism of RepWorth.',
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
          'Cookies are small browser records; local storage and session storage perform related functions. RepWorth uses these technologies for login, security, approvals, preferences, and product analytics. Not every item below is set on every visit.',
          'Necessary storage supports functions you request. Analytics storage is a separate purpose and is not made strictly necessary simply because it is first-party or handled by our servers.',
        ],
      },
      {
        heading: 'Analytics',
        body: [
          'When the product analytics endpoint accepts an event, it sets or refreshes rw_analytics_id, a first-party pseudonymous identifier with a maximum age of one year. This links product interaction events. Events are recorded on our servers and sent to PostHog when configured; no PostHog browser SDK is required for that processing.',
          'This identifier is used for product measurement, not cross-context advertising. Deleting it does not delete events already recorded, and later interactions may set a new identifier. Contact support@repworth.net about privacy requests. See /legal/privacy for the information collected and how it is used.',
        ],
      },
      {
        heading: 'Storage Used by the Service',
        body: ['The lifetimes below reflect application settings; session refresh, sign-out, clearing storage, or provider settings can change how long a particular record remains.'],
        table: {
          headers: ['Storage', 'Purpose', 'Lifetime'],
          rows: [
            ['Supabase authentication storage (sb-* cookies)', 'Sign-in and session refresh', 'Managed by the authentication session and refreshed as needed'],
            ['__device and __csrf', 'Approval-device binding and request security', 'Up to 48 hours'],
            ['zernio_connect_session', 'Securely complete a Google connection', 'Up to 15 minutes'],
            ['rw_delete_data_fresh_auth', 'Confirm recent authentication for account deletion', 'Up to 10 minutes'],
            ['rw_location_scope', 'Remember the selected business location', 'Up to one year'],
            ['rw_impersonation', 'Authorized support-session control', 'Limited to the support session'],
            ['rw_analytics_id', 'Pseudonymous product analytics', 'Up to one year; renewed on accepted events'],
            ['Browser session storage', 'Carry an entered email between sign-in/signup steps', 'Cleared on use or when the tab session ends'],
            ['Browser local storage', 'Remember dismissal of an account-status notice', 'Until cleared or replaced'],
          ],
        },
      },
      {
        heading: 'Third-party Services',
        body: [
          'Payment checkout, Google connection or place lookup, bot protection, and messaging services may use their own storage when you interact with them. Those providers explain their practices in their privacy notices. Our Sentry configuration disables session replay.',
        ],
      },
      {
        heading: 'Managing Cookies',
        body: [
          'You can control cookies through your browser settings, but blocking necessary cookies may prevent login, approval, or account-management flows from working.',
          'You can also clear local and session storage in your browser. These controls do not cancel a subscription, remove provider records, or replace a request to delete personal information. We do not currently provide an in-product cookie-preference center. For assistance, contact support@repworth.net.',
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
          'This inventory covers providers and connected platforms used by implemented RepWorth features. Actual processing depends on enabled features and configuration. Listing a provider does not mean every customer\'s information is sent to it. Providers such as Google, Stripe, and messaging platforms may also process information independently under their own terms.',
          'Purposes and data categories are listed below. For contractual sub-processor details, processing locations, or a data processing agreement, contact support@repworth.net. This inventory is not an executed DPA and does not promise a particular hosting region or transfer certification.',
        ],
        table: subProcessorTable,
      },
      {
        heading: 'Changes and Questions',
        body: [
          'We update this inventory when provider use changes. Any additional notice, authorization, or objection rights are governed by your applicable data processing agreement and law. Contact support@repworth.net with questions about a provider or the information it receives.',
        ],
      },
    ],
  },
};
