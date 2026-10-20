import { Global, Module } from '@nestjs/common';
import { QuranService } from './quran.service';

@Global()
@Module({ providers: [QuranService], exports: [QuranService] })
export class QuranModule {}
