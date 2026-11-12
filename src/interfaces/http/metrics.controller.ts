import { Controller, Get, Header } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { PrometheusWageringMetrics } from "../../infrastructure/observability/prometheus-metrics";
import { Public } from "./auth/public.decorator";

@ApiExcludeController()
@Public()
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: PrometheusWageringMetrics) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
