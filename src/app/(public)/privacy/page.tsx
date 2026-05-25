import { permanentRedirect } from 'next/navigation';

export default function PrivacyPage() {
  permanentRedirect('/legal/privacy');
}
