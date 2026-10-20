import { Controller, Get } from '@nestjs/common';
import { RulesService } from './rules.service';
import { enabledRounds } from './rules.types';

/** The current rules for the app's how-to-play page (no key needed). */
@Controller('rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get()
  get() {
    return { ...this.rules.current, enabledRounds: enabledRounds(this.rules.current) };
  }
}
