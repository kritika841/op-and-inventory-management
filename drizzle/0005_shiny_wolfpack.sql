CREATE TABLE `shipment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text,
	`awb` text NOT NULL,
	`status` text NOT NULL,
	`status_code` text,
	`courier` text,
	`occurred_at` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shipment_events_order_idx` ON `shipment_events` (`order_id`);--> statement-breakpoint
CREATE INDEX `shipment_events_awb_idx` ON `shipment_events` (`awb`);--> statement-breakpoint
CREATE INDEX `shipment_events_occurred_idx` ON `shipment_events` (`occurred_at`);