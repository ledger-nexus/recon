// Clerk hosted sign-in page. Catch-all route segment ([[...sign-in]])
// is Clerk's required convention so the embedded SignIn component can
// handle multi-step flows (password, email verification, MFA, etc.)
// without us defining each subroute.

import { isClerkEnabled } from "@/lib/auth/clerk";
import Link from "next/link";

export default async function SignInPage() {
  if (!isClerkEnabled()) {
    return (
      <div className="mx-auto max-w-md p-8">
        <h1 className="text-xl font-semibold text-ink-900">Sign-in not configured</h1>
        <p className="mt-3 text-sm text-ink-600">
          This deployment runs with no auth provider. Set{" "}
          <code>CLERK_SECRET_KEY</code> + <code>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code>{" "}
          in the deployment env to enable Clerk.
        </p>
        <Link href="/" className="mt-6 inline-block text-sm text-blue-600 underline">
          ← Return to app
        </Link>
      </div>
    );
  }

  const { SignIn } = await import("@clerk/nextjs");
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50">
      <SignIn />
    </div>
  );
}
