import { Module } from '@nestjs/common';

import { TerminalDiagnosticsMetricsService } from './terminal-diagnostics-metrics.service';

/**
 * Identifier-free leaf collector shared by the terminal producer and `/metrics`
 * projection without introducing a TerminalModule <-> MetricsModule cycle.
 */
@Module({
  providers: [TerminalDiagnosticsMetricsService],
  exports: [TerminalDiagnosticsMetricsService],
})
export class TerminalDiagnosticsMetricsModule {}
