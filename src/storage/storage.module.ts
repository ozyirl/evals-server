import { Module } from '@nestjs/common';
import { ImageStoreService } from './image-store.service';

@Module({ providers: [ImageStoreService], exports: [ImageStoreService] })
export class StorageModule {}
