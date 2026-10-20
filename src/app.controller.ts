import { Controller, Get } from '@nestjs/common';

/** Server status, so the root URL answers in a browser. */
@Controller()
export class AppController {
  @Get()
  status() {
    return {
      name: 'almaher-server',
      status: 'running',
      dashboard: 'http://localhost:3001',
    };
  }
}
