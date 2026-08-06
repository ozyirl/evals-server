import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { ClerkAuthGuard } from './clerk-auth.guard';

jest.mock('jsonwebtoken');

function createContext(authorization?: string): ExecutionContext {
  const request: { headers: Record<string, string>; auth?: unknown } = {
    headers: authorization ? { authorization } : {},
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('ClerkAuthGuard', () => {
  const OLD_ENV = process.env;
  let guard: ClerkAuthGuard;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      CLERK_PEM_PUBLIC_KEY: 'test-public-key',
      CLERK_ISSUER: 'https://related-walrus-18.clerk.accounts.dev',
    };
    guard = new ClerkAuthGuard();
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('throws when no Authorization header is present', () => {
    expect(() => guard.canActivate(createContext())).toThrow(
      UnauthorizedException,
    );
  });

  it('throws when the token fails verification', () => {
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error('invalid signature');
    });

    expect(() => guard.canActivate(createContext('Bearer bad.token'))).toThrow(
      UnauthorizedException,
    );
  });

  it('attaches the decoded payload to the request and allows access', () => {
    const payload = { sub: 'user_123', iss: 'https://related-walrus-18.clerk.accounts.dev' };
    (jwt.verify as jest.Mock).mockReturnValue(payload);

    const context = createContext('Bearer good.token');
    const result = guard.canActivate(context);

    expect(result).toBe(true);
    expect(jwt.verify).toHaveBeenCalledWith('good.token', 'test-public-key', {
      algorithms: ['RS256'],
      issuer: 'https://related-walrus-18.clerk.accounts.dev',
    });
    expect(context.switchToHttp().getRequest().auth).toEqual(payload);
  });
});
