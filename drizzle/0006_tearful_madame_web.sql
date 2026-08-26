ALTER TABLE `orders` ADD `cancellation_source` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `cancellation_reason` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `cancelled_by` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `cancelled_at` text;