import { Module } from '@nestjs/common';
import { ImagePrompterService } from './image-prompter.service';

@Module({ providers: [ImagePrompterService], exports: [ImagePrompterService] })
export class ImagePrompterModule {}
