import { Injectable } from "@nestjs/common";
import { Clock, IdGenerator } from "../../application/ports/system";

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

@Injectable()
export class UuidV7Generator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
