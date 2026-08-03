import { Module } from '@nestjs/common';
import { PixelsController } from './pixels.controller';
import { PixelsService } from './pixels.service';

@Module({
  controllers: [PixelsController],
  providers: [PixelsService],
  exports: [PixelsService],
})
export class PixelsModule {}
