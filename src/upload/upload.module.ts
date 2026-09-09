import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { AgentModule } from '../agent/agent.module';
import { AuthModule } from '../auth/auth.module';
import { AssessmentsModule } from '../assessments/assessments.module';

@Module({
  imports: [AssessmentsModule, AuthModule, AgentModule],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}
