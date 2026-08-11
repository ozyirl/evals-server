import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { ImageQualityModule } from '../image-quality/image-quality.module';

@Module({
  imports: [ImageQualityModule],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}
