import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user?: {
      githubId: string;
      login: string;
      admin: boolean;
    };
    expires: DefaultSession['expires'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    githubId?: string;
    login?: string;
  }
}
