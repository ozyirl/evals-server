import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppService } from './app.service';
import { Auth } from './auth/auth.decorator';
import { CurrentUser } from './auth/current-user.decorator';
import { ClerkJwtPayload } from './auth/clerk-jwt-payload.interface';
import { DB, Database } from './db/db.module';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    @Inject(DB) private readonly db: Database,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Auth()
  @Get('me')
  getMe(@CurrentUser() user: ClerkJwtPayload): ClerkJwtPayload {
    return user;
  }

  @Get('health')
  getHealth(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('health/db')
  async getDbHealth(): Promise<{ status: string; timestamp: string }> {
    await this.db.execute(sql`select 1`);
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
