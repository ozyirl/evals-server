import { Module } from '@nestjs/common';
import { AssessmentsModule } from '../assessments/assessments.module';
import { ImageQaService } from './image-qa.service';

@Module({
  imports: [AssessmentsModule],
  providers: [ImageQaService],
  exports: [ImageQaService],
})
export class ImageQaModule {}
