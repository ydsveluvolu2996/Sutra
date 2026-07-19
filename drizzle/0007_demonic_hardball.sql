ALTER TABLE `local_schedule_mutation_outbox` ADD `mutation_sequence` integer;--> statement-breakpoint
UPDATE `local_schedule_mutation_outbox`
SET `mutation_sequence` = rowid
WHERE `mutation_sequence` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `local_schedule_mutation_outbox_sequence_uq` ON `local_schedule_mutation_outbox` (`mutation_sequence`);
