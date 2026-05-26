export default function HelpContactPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-semibold text-gray-900">Contact support</h1>
      <p className="mt-3 text-gray-600">
        For account help, email support@repworth.net. Billing questions go to
        billing@repworth.net. Security reports go to security@repworth.net.
      </p>
      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900">Response targets</h2>
        <ul className="mt-3 list-disc pl-5 text-gray-700">
          <li>Basic and Founders: 24 business hours.</li>
          <li>Standard: 8 business hours.</li>
          <li>Premium: 2 business hours.</li>
        </ul>
      </section>
      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900">Common help topics</h2>
        <p className="mt-3 text-gray-700">
          Email support@repworth.net for step-by-step help with any of these:
        </p>
        <ul className="mt-3 list-disc pl-5 text-gray-700">
          <li>Connecting your Google Business Profile</li>
          <li>Billing and past-due recovery</li>
          <li>Importing locations by CSV</li>
        </ul>
      </section>
    </main>
  );
}
