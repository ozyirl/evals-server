import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { ClerkJwtPayload } from './clerk-jwt-payload.interface';

export const CurrentUser = createParamDecorator(
  (data: keyof ClerkJwtPayload | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const auth = request.auth;
    return data ? auth?.[data] : auth;
  },
);
