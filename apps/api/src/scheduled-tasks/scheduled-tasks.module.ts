import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { ScheduledTasksController } from './scheduled-tasks.controller';
import { ScheduledTasksService } from './scheduled-tasks.service';

@Module({
  imports: [TasksModule],
  controllers: [ScheduledTasksController],
  providers: [ScheduledTasksService],
  exports: [ScheduledTasksService],
})
export class ScheduledTasksModule {}
