import { Module } from '@nestjs/common';
import { ImagePostProcessService } from './image-postprocess.service';

@Module({
  providers: [ImagePostProcessService],
  exports: [ImagePostProcessService],
})
export class ImagePostProcessModule {}
