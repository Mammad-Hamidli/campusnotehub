import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth/LoginForm';

export const metadata: Metadata = { title: 'Log in', robots: { index: false, follow: false } };

export default function LoginPage() {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-12">
      <LoginForm />
    </main>
  );
}
