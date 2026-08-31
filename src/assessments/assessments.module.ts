import { Module } from '@nestjs/common';
import { AssessmentLogService } from './assessment-log.service';

@Module({
  providers: [AssessmentLogService],
  exports: [AssessmentLogService],
})
export class AssessmentsModule {}
