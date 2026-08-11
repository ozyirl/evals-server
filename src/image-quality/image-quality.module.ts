import { Module } from '@nestjs/common';
import { ImageQualityService } from './image-quality.service';

@Module({
  providers: [ImageQualityService],
  exports: [ImageQualityService],
})
export class ImageQualityModule {}
