CREATE TABLE `courier_sla` (
	`id` text PRIMARY KEY NOT NULL,
	`courier_name` text NOT NULL,
	`auto_cancel_days` integer NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `courier_sla_name_unique` ON `courier_sla` (`courier_name`);--> statement-breakpoint
CREATE TABLE `order_status_log` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`changed_by` text,
	`reason` text,
	`notes` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `order_status_log_order_idx` ON `order_status_log` (`order_id`);--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`attempt_number` integer DEFAULT 1 NOT NULL,
	`shiprocket_order_id` text,
	`shiprocket_shipment_id` text,
	`awb_number` text,
	`courier_name` text,
	`courier_auto_cancel_days` integer,
	`auto_cancel_deadline` text,
	`status` text NOT NULL,
	`manifested_at` text,
	`label_url` text,
	`label_printed_at` text,
	`pickup_scheduled_at` text,
	`picked_up_at` text,
	`delivered_at` text,
	`auto_cancelled_at` text,
	`cancel_reason` text,
	`has_ndr` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shipments_order_idx` ON `shipments` (`order_id`);--> statement-breakpoint
CREATE INDEX `shipments_awb_idx` ON `shipments` (`awb_number`);--> statement-breakpoint
CREATE INDEX `shipments_active_idx` ON `shipments` (`is_active`);--> statement-breakpoint
CREATE TABLE `tracking_events` (
	`id` text PRIMARY KEY NOT NULL,
	`shipment_id` text,
	`order_id` text NOT NULL,
	`event_tag` text NOT NULL,
	`event_description` text,
	`location` text,
	`event_timestamp` text NOT NULL,
	`received_at` text NOT NULL,
	`raw_payload` text
);
--> statement-breakpoint
CREATE INDEX `tracking_events_shipment_idx` ON `tracking_events` (`shipment_id`);--> statement-breakpoint
CREATE INDEX `tracking_events_order_idx` ON `tracking_events` (`order_id`);--> statement-breakpoint
CREATE INDEX `tracking_events_timestamp_idx` ON `tracking_events` (`event_timestamp`);--> statement-breakpoint
ALTER TABLE `orders` ADD `current_status` text DEFAULT 'INGESTED' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `rto_risk` text DEFAULT 'UNTAGGED' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `rto_score` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `assigned_agent_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `stuck_reason` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `stuck_since` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `stuck_notes` text;