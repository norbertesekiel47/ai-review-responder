# Privacy Policy

Version: 2026-09-16
Effective date: 2026-09-16
Legal review status: pending lawyer review

Review copy of `src/lib/legal/content.ts`. Keep this file synchronized with the route-backed document; see `legal-review.md` for publication status and open questions.

## Overview

REPWORTH, INC., a Delaware corporation, operates the RepWorth website and business reputation-management service. This policy covers visitors, account users, business contacts, and individuals whose information is processed through our features.

We determine how account, billing, support, security, and website information is used. For customer-provided contacts and business review workflows, we generally process information on the business customer's instructions. That business is responsible for its own privacy notice and lawful use of the information. A person may have rights even if they do not have a RepWorth account.

## Data We Process

- Account data: name, email address, phone number if provided, authentication metadata, and account preferences.
- Business profile data: business name, location data, Google Business Profile identifiers, and connected-account metadata.
- Review data: Google review text, reviewer display name, rating, review date, and source identifiers.
- Response data: AI-generated response drafts, edits, approvals, posting status, and audit metadata.
- Customer contact data, when review-request features are used: names, email addresses, phone numbers, visit dates, uploaded notes, consent evidence, delivery results, and opt-out or suppression records.
- AI and automation data, when enabled: assistant messages, relevant business context, proposed and applied settings, automation policies, decisions, summaries, and action records.
- Notification data: email addresses, phone numbers, Telegram identifiers when enabled, delivery metadata, and message content needed to provide service notifications.
- Billing data: Stripe customer, subscription, checkout, and invoice identifiers. RepWorth does not store raw card numbers.
- Reliability and service metadata: IP address, browser/device and request metadata, cookies and pseudonymous identifiers, timestamps, usage events, logs, scrubbed diagnostics, and service-operation metrics.
- Support and inquiry data: information you provide through contact forms, demo requests, feedback, and support correspondence.

## Sources of Information

We receive information from you, your business and its authorized users, connected Google accounts through Zernio, public business and review sources, payment and messaging providers, and your browser or device. Optional features only process their associated information when used or enabled. Public availability does not eliminate all privacy or platform restrictions.

## How We Use Data

- To monitor Google reviews and normalize review data.
- To generate AI response drafts for owner approval.
- To display, edit, and publish responses after your approval or under an expressly enabled Autopilot policy.
- To provide enabled summaries, triage, automation controls, assistant conversations, and business insights.
- To deliver authorized review requests and record consent, delivery, and opt-outs when those features are enabled.
- To send approval, notification, onboarding, and account emails.
- To send WhatsApp or Telegram service notifications when enabled.
- To process subscription billing through Stripe.
- To secure the Service, prevent abuse, debug errors, and measure service-operation outcomes.

## AI Draft Generation

Review text, responses, and relevant business context may be sent to OpenAI or Anthropic for draft generation, summaries, classification, safety checks, and other enabled AI features. If you use the assistant, its messages and relevant account context may also be processed by those providers. Only provide information appropriate for the task.

Copilot replies require individual approval. Where available, an expressly enabled Autopilot policy can authorize eligible replies without individual approval, subject to the controls shown in the product. Automated checks may make mistakes.

RepWorth does not use customer content to train a general-purpose AI model. We use commercial AI APIs; provider retention, abuse-monitoring, and data handling are governed by the applicable provider agreements and settings. This is not a promise of zero provider retention.

## Google Account Information

When you connect Google Business Profile, our connection provider Zernio handles the authorization needed to retrieve authorized location and review information and publish authorized replies. We process connected-account identifiers, connection status, review data, and response records for the features you use. We do not request your Google password.

You can revoke the relevant third-party connection in your Google account or disconnect in RepWorth. Revocation stops future authorized access but does not itself cancel your subscription, delete retained records, or remove replies already published. Contact support@repworth.net to request deletion.

## Sub-processors

The providers below support our implemented data flows. Optional providers receive data only when their features and integrations are used or configured. Some connected platforms and payment providers also act independently under their own privacy policies; not every listed company acts solely as our sub-processor.

| Vendor | Purpose | Data classes |
| --- | --- | --- |
| OpenAI | AI replies, summaries, classification, safety checks, and enabled assistant features | Review and response text, relevant business context, and prompts or conversations for the feature used |
| Anthropic | AI processing, including fallback when configured | Review and response text, relevant business context, and prompts or conversations for the feature used |
| Stripe | Payments | Billing identifiers, name, email, address, subscription metadata |
| Supabase | Database, authentication, and storage | Account, business, review, response, contact, consent, and authentication data |
| Vercel | Web hosting and bot protection | Requests, IP/device metadata, and application data handled by the web service |
| Railway | Worker hosting and Redis job queues | Application data and job payloads needed for processing and delivery |
| Upstash | Redis cache, rate limits, and usage controls | Cache entries, identifiers, counters, and operational metadata |
| Resend | Email | Email addresses, message content, delivery metadata |
| Twilio | WhatsApp delivery when enabled | Phone numbers, message content, consent and delivery metadata |
| Meta / WhatsApp | WhatsApp messaging platform when enabled | Phone numbers, message content, and messaging metadata |
| Telegram | Bot delivery when enabled | Telegram identifiers, message content |
| Zernio | Google review ingestion and posting | GBP OAuth tokens, review data, posting metadata |
| Sentry | Error and performance monitoring | Scrubbed diagnostics, request and device metadata, and performance events |
| PostHog | Server-dispatched product analytics when configured | Pseudonymous visitor/account identifiers, usage events, timestamps, and filtered event properties |
| SerpAPI | Public business/review lookup, demos, and enabled ranking or competitor features | Business identifiers, search/location queries, and public business and review data |
| Google Maps Platform | Place autocomplete and map/place metadata | Place query metadata |
| Google Business Profile | Connected review source and destination for authorized replies | Connected-account permissions, location/review data, and published responses |

## Other Disclosures

We disclose information to authorized account users, to connected platforms when you direct an action, and to providers needed to operate the Service. An approved or policy-authorized reply sent to Google becomes public. A message sent through email, WhatsApp, or Telegram is handled by that channel and its providers.

We may disclose information where legally required, to protect rights and investigate misuse, or in a business transaction subject to applicable confidentiality and data-protection requirements. Additional restrictions on connected-platform information continue to apply.

RepWorth does not sell personal information or share it for cross-context behavioral advertising. We do not use customer contact lists or mobile opt-in information for other companies' marketing.

## Mobile Data

If you opt in to WhatsApp notifications, RepWorth uses your phone number and consent information to deliver service notifications and related account messages through Twilio and WhatsApp. Telegram identifiers are used for the bot notifications you enable. Providers receive message content and delivery information needed for those services.

Mobile opt-in data and mobile phone numbers are not shared, sold, rented, or disclosed to third parties or affiliates for their marketing or promotional purposes. Reply STOP to opt out of WhatsApp, or use the available channel controls. For help, email support@repworth.net.

## Cookies and Sessions

We use authentication, security, approval-session, and preference storage. The product analytics endpoint also sets a first-party pseudonymous cookie, rw_analytics_id, for up to one year and may renew it on later events. Server-side dispatch to PostHog does not make this cookie necessary or eliminate applicable consent requirements. See /legal/cookies for storage purposes and controls.

We use filtered usage events to understand onboarding and product operation. PostHog receives these events when configured. Our Sentry configuration disables session replay. We do not currently interpret a browser Do Not Track signal as a separate product setting. We do not sell or share personal information for cross-context advertising, and Global Privacy Control does not currently change that practice.

## Security

We use encrypted transport, access controls scoped to accounts and locations, and hashed approval-token records. Raw approval links must be delivered to their recipients, so protect them like credentials. Access by authorized personnel may be needed for support, security, and service operation.

No service can guarantee absolute security. Our public security page at /security describes selected safeguards; it is not a certification, HIPAA compliance claim, or guarantee that sensitive information will always be detected.

## Retention

Retention depends on the information, feature, customer instructions, legal obligations, platform restrictions, and the need to resolve disputes or maintain security. Subscription cancellation does not automatically delete account or review records. You can separately request account deletion or exercise your privacy rights.

The account-deletion workflow schedules permanent purging after a 30-day waiting period. Processing is stopped earlier while billing and connected services are torn down. Cleanup failures or provider handling can delay completion; this is not a promise that every copy disappears on day 30. Limited consent, suppression, billing, security, and legal records may be retained where necessary. Backups and independent provider records may follow separate retention cycles.

Our payment-provider cleanup redacts the Stripe customer record and detaches saved payment methods, but does not erase all provider records. Retained records can include paid invoices with their original billing name and address, tax identifiers, and detached payment-method records with billing contact details and the last four digits of the card. The payment processor handles its own retention for financial recordkeeping, tax, fraud prevention, and legal obligations.

## Your Rights

Email support@repworth.net to request access, correction, deletion, or a copy of your personal information, or to ask about our processing. Include enough context to locate your information, such as the account email or the business that contacted you; do not send passwords or full payment details. We may proportionately verify your identity or an authorized agent's authority before acting.

Depending on your location and the law applicable to the processing, you may also have rights to portability, restriction, objection, withdrawal of consent, an appeal of a denied request, or a complaint to a privacy regulator. Where an appeal right applies, reply to our decision or email support with the subject Privacy appeal. We respond within applicable legal deadlines and do not unlawfully discriminate for exercising rights. Exceptions may apply, including required recordkeeping and other people's rights.

For data processed on a business customer's instructions, we may refer the request to that business or assist it in responding. Review-request recipients may also use the message's unsubscribe mechanism. Unsubscribing does not require a RepWorth account. Deleting information from RepWorth does not remove an original Google review; use Google's controls for that request.

## International Processing and Legal Bases

We and our providers may process information in the United States and other countries, which may have different privacy laws. Where a transfer safeguard is legally required, it must be in place for the relevant processing. Contact support@repworth.net for information about the arrangements applicable to your account; this policy does not itself establish a transfer agreement or claim participation in a certification framework.

Where European or UK data-protection law applies to processing for which we are responsible, the relevant legal basis may be performing a contract with you, our legitimate interests in providing and securing the Service and responding to inquiries, compliance with legal obligations, or consent where required. Business customers determine the legal basis for their instructions. You may withdraw consent without affecting the lawfulness of earlier processing.

## Children and Sensitive Information

The Service is intended for adult business users and is not directed to children under 13. We do not knowingly collect account information from children under 13. Contact us if you believe a child has provided information so we can investigate and take appropriate action.

Do not upload private health records or other sensitive information not needed for reputation management. Automated filtering is limited and does not make the Service suitable for protected health information or replace a required business associate agreement.

## Changes to This Policy

We will update the effective date and provide notice of material changes as required, including obtaining fresh consent where required for a new use of information. A privacy notice describes our practices; continued use alone is not consent to processing that legally requires affirmative consent.

## Contact

REPWORTH, INC., a Delaware corporation

Privacy requests: support@repworth.net

Security reports: security@repworth.net

Website: repworth.net
