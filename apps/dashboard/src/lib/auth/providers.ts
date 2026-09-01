import type { Profile } from "next-auth";
import type { OIDCConfig } from "next-auth/providers";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import WorkOS from "next-auth/providers/workos";

/**
 * Which sign-in methods exist at all.
 *
 * Default is presence of credentials, which is the least surprising rule: a
 * provider you have not configured cannot be a way in. The explicit flags are
 * for turning off a provider whose credentials are set — an install that keeps
 * AUTH_GITHUB_ID around but wants Google only.
 *
 * This matters more than a convenience toggle. There is no signup allowlist
 * anywhere in this app: the signIn callback below never denies, and a new user
 * lands on /onboarding and creates their own workspace. So every enabled
 * provider is an open registration for anyone holding an account with it.
 */
function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true";
}

export const githubEnabled = flag(
  "AUTH_GITHUB_ENABLED",
  Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET),
);

export const googleEnabled = flag(
  "AUTH_GOOGLE_ENABLED",
  Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
);

export const magicLinkEnabled = flag(
  "AUTH_MAGIC_LINK_ENABLED",
  process.env.NODE_ENV === "development" || process.env.SELF_HOST === "true",
);

/**
 * Restrict Google sign-in to one or more Google Workspace domains, e.g.
 * AUTH_GOOGLE_ALLOWED_DOMAINS=bycoded.com. Empty means no restriction.
 */
export const googleAllowedDomains = (
  process.env.AUTH_GOOGLE_ALLOWED_DOMAINS ?? ""
)
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

/**
 * The enforcement half of AUTH_GOOGLE_ALLOWED_DOMAINS, called from the signIn
 * callback. The `hd` authorization parameter is only a hint to the account
 * chooser — a user can hand-edit the authorize URL or pick another account —
 * so the domain has to be checked again on the profile that comes back.
 *
 * `email_verified` is required because without it a self-asserted address on a
 * consumer account would pass the domain test. `hd` is checked when the claim
 * is present: it is issued only for Workspace accounts, so a personal Gmail
 * that merely has a matching alias is refused.
 */
export function isGoogleProfileAllowed(profile: {
  email?: string | null;
  email_verified?: boolean | null;
  hd?: string | null;
}): boolean {
  if (googleAllowedDomains.length === 0) return true;
  if (!profile?.email || profile.email_verified !== true) return false;

  const emailDomain = profile.email.split("@").pop()?.toLowerCase();
  if (!emailDomain || !googleAllowedDomains.includes(emailDomain)) return false;

  const hd = profile.hd?.toLowerCase();
  if (hd && !googleAllowedDomains.includes(hd)) return false;

  return true;
}

export const GitHubProvider = GitHub({
  allowDangerousEmailAccountLinking: true,
});

export const GoogleProvider = Google({
  allowDangerousEmailAccountLinking: true,
  authorization: {
    params: {
      // See https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
      prompt: "select_account",
      // Narrows the account chooser to the one Workspace domain. A hint, not a
      // control — isGoogleProfileAllowed above is the control.
      ...(googleAllowedDomains.length === 1
        ? { hd: googleAllowedDomains[0] }
        : {}),
      // scope:
      //   "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email",
    },
  },
});

export const OIDCProvider: OIDCConfig<Profile> = {
  id: "oidc",
  name: process.env.AUTH_OIDC_NAME ?? "SSO",
  type: "oidc",
  issuer: process.env.AUTH_OIDC_ISSUER,
  clientId: process.env.AUTH_OIDC_ID,
  clientSecret: process.env.AUTH_OIDC_SECRET,
};

// The stock provider bakes an empty `connection=` into the authorize URL, and
// WorkOS requires exactly one of connection/organization/provider — so the
// empty one collides with the per-request `organization` we pass at signIn.
export const WorkOSProvider = WorkOS({
  clientId: process.env.AUTH_WORKOS_ID,
  clientSecret: process.env.AUTH_WORKOS_SECRET,
  authorization: { url: "https://api.workos.com/sso/authorize", params: {} },
  allowDangerousEmailAccountLinking: true,
});

/**
 * The magic-link provider.
 *
 * It does NOT send mail: the link is printed to this container's stdout. That
 * is upstream behaviour, kept here, and it has a consequence worth stating
 * plainly — anyone who can read these logs can sign in as any address, without
 * a password and without controlling the mailbox. So do not ship this
 * container's logs anywhere shared, and prefer AUTH_MAGIC_LINK_ENABLED=false
 * with a real provider (Google or OIDC) for any install more than one operator
 * uses.
 */
export const ResendProvider = Resend({
  apiKey: undefined, // REMINDER: keep undefined to avoid sending emails
  async sendVerificationRequest(params) {
    console.log("");
    console.log(`>>> Magic Link: ${params.url}`);
    console.log("");
  },
});
