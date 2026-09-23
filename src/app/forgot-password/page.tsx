import type { Metadata } from 'next';
import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm';

export const metadata: Metadata = {
  title: 'Forgot password',
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-12">
      <ForgotPasswordForm />
    </main>
  );
}
