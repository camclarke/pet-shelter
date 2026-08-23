import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Mi cuenta',
  robots: { index: false },
};

/**
 * Placeholder. Auth (email/password + Google) is a separate task — see
 * CLAUDE.md and task #5. This page exists now only so the header link
 * resolves instead of 404ing.
 */
export default function AccountPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <h1 className="t-title">Mi cuenta</h1>
      <p style={{ marginTop: 'var(--space-2)', maxWidth: '60ch', opacity: 0.8 }}>
        El inicio de sesión con correo y Google está en construcción.
      </p>
    </div>
  );
}
