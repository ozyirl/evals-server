import { Module } from '@nestjs/common';
import { ImageRouterService } from './image-router.service';

@Module({
  providers: [ImageRouterService],
  exports: [ImageRouterService],
})
export class RoutingModule {}
