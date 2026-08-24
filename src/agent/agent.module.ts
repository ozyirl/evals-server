import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImageQualityModule } from '../image-quality/image-quality.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ImageAgentService } from './image-agent.service';

@Module({
  imports: [AuthModule, ImageQualityModule],
  controllers: [AgentController],
  providers: [AgentService, ImageAgentService],
})
export class AgentModule {}
