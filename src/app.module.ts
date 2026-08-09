import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { DbModule } from './db/db.module';
import { AgentModule } from './agent/agent.module';
import { UploadModule } from './upload/upload.module';

@Module({
  imports: [AuthModule, DbModule, AgentModule, UploadModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
