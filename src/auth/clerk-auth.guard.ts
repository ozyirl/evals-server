import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { ClerkJwtPayload } from './clerk-jwt-payload.interface';

declare module 'express' {
  interface Request {
    auth?: ClerkJwtPayload;
  }
}

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    request.auth = this.verify(token);
    return true;
  }

  private verify(token: string): ClerkJwtPayload {
    const publicKey = process.env.CLERK_PEM_PUBLIC_KEY;
    if (!publicKey) {
      throw new InternalServerErrorException(
        'CLERK_PEM_PUBLIC_KEY is not configured',
      );
    }

    try {
      return jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
        issuer: process.env.CLERK_ISSUER,
      }) as ClerkJwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return undefined;
  }
  return header.slice('Bearer '.length);
}
