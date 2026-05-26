// Clerk hosted sign-up page. See sign-in/[[...sign-in]]/page.tsx for
// the rationale on the catch-all route segment.

import { isClerkEnabled } from "@/lib/auth/clerk";
import Link from "next/link";

export default async function SignUpPage() {
  if (!isClerkEnabled()) {
    return (
      <div className="mx-auto max-w-md p-8">
        <h1 className="text-xl font-semibold text-ink-900">Sign-up not configured</h1>
        <p className="mt-3 text-sm text-ink-600">
          New accounts are created in ledger-core's onboarding flow, then
          this app inherits the user's session. If you reached this page
          directly, return to the main app.
        </p>
        <Link href="/" className="mt-6 inline-block text-sm text-blue-600 underline">
          ← Return to app
        </Link>
      </div>
    );
  }

  const { SignUp } = await import("@clerk/nextjs");
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50">
      <SignUp />
    </div>
  );
}
