CREATE TABLE `campaign_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`order_id` text NOT NULL,
	`assigned_agent_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_assignments_order_unique` ON `campaign_assignments` (`order_id`);--> statement-breakpoint
CREATE INDEX `campaign_assignments_campaign_idx` ON `campaign_assignments` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `campaign_assignments_agent_idx` ON `campaign_assignments` (`assigned_agent_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`urgency` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `campaigns_active_idx` ON `campaigns` (`is_active`);--> statement-breakpoint
CREATE TABLE `order_edit_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`field_name` text NOT NULL,
	`old_value` text,
	`new_value` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` text,
	`review_note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `order_edit_requests_order_idx` ON `order_edit_requests` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_edit_requests_status_idx` ON `order_edit_requests` (`status`);--> statement-breakpoint
CREATE TABLE `recall_cooldown_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`default_hours` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `recall_cooldown_settings` (`id`, `default_hours`, `updated_by`, `updated_at`) VALUES ('default', 24, 'system', CURRENT_TIMESTAMP);
--> statement-breakpoint
CREATE TABLE `recall_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`overridden_by` text NOT NULL,
	`reason` text NOT NULL,
	`original_next_action_at` text,
	`new_next_action_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recall_overrides_order_idx` ON `recall_overrides` (`order_id`);--> statement-breakpoint
CREATE INDEX `recall_overrides_created_idx` ON `recall_overrides` (`created_at`);--> statement-breakpoint
ALTER TABLE `confirmation_attempts` ADD `attempt_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `confirmation_attempts` ADD `call_picked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `confirmation_attempts` ADD `rejection_reason` text;--> statement-breakpoint
ALTER TABLE `confirmation_attempts` ADD `next_action_at` text;--> statement-breakpoint
CREATE INDEX `confirmation_attempts_order_created_idx` ON `confirmation_attempts` (`order_id`,`created_at`);
