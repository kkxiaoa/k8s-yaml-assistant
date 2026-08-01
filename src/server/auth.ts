import {
  getServerSession,
  type NextAuthOptions,
  type Profile,
  type Session,
} from 'next-auth';
import GitHubProviderImport, {
  type GithubProfile,
} from 'next-auth/providers/github';

export interface AuthenticatedIdentity {
  githubId: string;
  login: string;
  admin: boolean;
}

type AuthEnvironment = Readonly<Record<string, string | undefined>>;
type Fetch = typeof fetch;
type GitHubIdentityProfile = GithubProfile & Profile;
const GitHubProvider = (
  typeof GitHubProviderImport === 'function'
    ? GitHubProviderImport
    : (
        GitHubProviderImport as unknown as {
          default: typeof GitHubProviderImport;
        }
      ).default
) as typeof GitHubProviderImport;

const GITHUB_ID = /^[1-9][0-9]{0,19}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function normalizedGithubId(value: unknown): string | null {
  const text =
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';
  return GITHUB_ID.test(text) ? text : null;
}

function normalizedGithubLogin(value: unknown): string | null {
  return typeof value === 'string' && GITHUB_LOGIN.test(value) ? value : null;
}

export function isAdminGithubId(
  githubId: string,
  environment: AuthEnvironment = process.env,
): boolean {
  const adminId = normalizedGithubId(environment.ADMIN_GITHUB_ID);
  return adminId !== null && githubId === adminId;
}

export function identityFromSession(
  session: Session | null,
): AuthenticatedIdentity | null {
  const githubId = normalizedGithubId(session?.user?.githubId);
  const login = normalizedGithubLogin(session?.user?.login);
  if (githubId === null || login === null) return null;
  return { githubId, login, admin: session?.user?.admin === true };
}

export function createAuthOptions(
  environment: AuthEnvironment = process.env,
  fetchImpl: Fetch = fetch,
): NextAuthOptions {
  return {
    secret: environment.NEXTAUTH_SECRET,
    session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
    providers: [
      GitHubProvider<GitHubIdentityProfile>({
        clientId: environment.GITHUB_ID ?? '',
        clientSecret: environment.GITHUB_SECRET ?? '',
        httpOptions: { timeout: 15_000 },
        authorization: {
          url: 'https://github.com/login/oauth/authorize',
          params: { scope: 'read:user' },
        },
        userinfo: {
          url: 'https://api.github.com/user',
          async request({ tokens }) {
            if (typeof tokens.access_token !== 'string') {
              throw new Error('GitHub access token missing');
            }
            const response = await fetchImpl('https://api.github.com/user', {
              headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${tokens.access_token}`,
                'X-GitHub-Api-Version': '2022-11-28',
              },
            });
            if (!response.ok) {
              throw new Error(`GitHub user request failed (${response.status})`);
            }
            const profile = (await response.json()) as GithubProfile;
            return {
              ...profile,
              name: profile.name ?? profile.login,
              email: profile.email ?? '',
            };
          },
        },
        profile(profile) {
          const githubId = normalizedGithubId(profile.id);
          const login = normalizedGithubLogin(profile.login);
          if (githubId === null || login === null) {
            throw new Error('GitHub profile identity invalid');
          }
          return {
            id: githubId,
            name: login,
            email: null,
            image:
              typeof profile.avatar_url === 'string'
                ? profile.avatar_url
                : null,
          };
        },
      }),
    ],
    callbacks: {
      jwt({ token, account, profile }) {
        const githubId =
          account?.provider === 'github'
            ? normalizedGithubId(
                (profile as Record<string, unknown> | undefined)?.id,
              )
            : normalizedGithubId(token.githubId);
        const login =
          account?.provider === 'github'
            ? normalizedGithubLogin(
                (profile as Record<string, unknown> | undefined)?.login,
              )
            : normalizedGithubLogin(token.login);
        if (githubId === null || login === null) return {};
        return {
          githubId,
          login,
        };
      },
      session({ session, token }) {
        const githubId = normalizedGithubId(token.githubId);
        const login = normalizedGithubLogin(token.login);
        if (githubId === null || login === null) {
          return { ...session, user: undefined };
        }
        return {
          ...session,
          user: {
            githubId,
            login,
            admin: isAdminGithubId(githubId, environment),
          },
        };
      },
    },
  };
}

export const authOptions = createAuthOptions();

export async function getAuthenticatedIdentity(): Promise<AuthenticatedIdentity | null> {
  return identityFromSession(await getServerSession(authOptions));
}

export async function getStrictAuthenticatedIdentity(): Promise<
  AuthenticatedIdentity | null
> {
  const session = await getServerSession(authOptions);
  const identity = identityFromSession(session);
  if (session !== null && identity === null) {
    throw new Error('authenticated identity invalid');
  }
  return identity;
}
