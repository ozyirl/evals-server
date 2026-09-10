import { Module } from '@nestjs/common';
import { AssessmentsModule } from '../assessments/assessments.module';
import { AuthModule } from '../auth/auth.module';
import { ImageQualityModule } from '../image-quality/image-quality.module';
import { RoutingModule } from '../routing/routing.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ImageAgentService } from './image-agent.service';
import { ImagePrompterModule } from '../image-prompter/image-prompter.module';
import { ImageQaModule } from '../image-qa/image-qa.module';

@Module({
  imports: [
    AssessmentsModule,
    AuthModule,
    ImageQualityModule,
    RoutingModule,
    ImagePrompterModule,
    ImageQaModule,
  ],
  controllers: [AgentController],
  providers: [AgentService, ImageAgentService],
  exports: [ImageAgentService],
})
export class AgentModule {}
