import { applyDecorators, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from './clerk-auth.guard';

export const Auth = () => applyDecorators(UseGuards(ClerkAuthGuard));
