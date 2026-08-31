import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { ImageQualityModule } from '../image-quality/image-quality.module';
import { AuthModule } from '../auth/auth.module';
import { AssessmentsModule } from '../assessments/assessments.module';

@Module({
  imports: [AssessmentsModule, AuthModule, ImageQualityModule],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}
