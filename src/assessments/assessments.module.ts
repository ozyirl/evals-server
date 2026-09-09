import { Module } from '@nestjs/common';
import { AssessmentLogService } from './assessment-log.service';
import { PipelineLogService } from './pipeline-log.service';

@Module({
  providers: [AssessmentLogService, PipelineLogService],
  exports: [AssessmentLogService, PipelineLogService],
})
export class AssessmentsModule {}
