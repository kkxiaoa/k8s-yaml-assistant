import NextAuthImport from 'next-auth';
import { authOptions } from '@/server/auth';

export const runtime = 'nodejs';

const NextAuth = (
  typeof NextAuthImport === 'function'
    ? NextAuthImport
    : (
        NextAuthImport as unknown as {
          default: typeof NextAuthImport;
        }
      ).default
) as typeof NextAuthImport;
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
