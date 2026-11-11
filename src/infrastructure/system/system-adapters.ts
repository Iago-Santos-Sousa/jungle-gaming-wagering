import { Injectable } from '@nestjs/common';
import { Clock, IdGenerator } from '../../application/ports/system';

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

// UUIDv7 nativo do Bun: ordenável no tempo, bom para índices B-tree
@Injectable()
export class UuidV7Generator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
