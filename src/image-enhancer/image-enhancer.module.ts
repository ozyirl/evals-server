import { Module } from '@nestjs/common';
import { ImageEnhancerService } from './image-enhancer.service';

@Module({ providers: [ImageEnhancerService], exports: [ImageEnhancerService] })
export class ImageEnhancerModule {}
