CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `confirmation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`user_id` text NOT NULL,
	`outcome` text NOT NULL,
	`note` text,
	`callback_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `integration_state` (
	`provider` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`secret_value` text,
	`last_synced_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inventory_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`movement_type` text NOT NULL,
	`quantity` integer NOT NULL,
	`reference_type` text,
	`reference_id` text,
	`reason` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`object_key` text NOT NULL,
	`file_name` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`quantity` integer NOT NULL,
	`allocated_quantity` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`shopify_order_id` text,
	`order_number` text NOT NULL,
	`customer_name` text NOT NULL,
	`customer_phone` text,
	`payment_method` text NOT NULL,
	`amount` integer NOT NULL,
	`status` text NOT NULL,
	`confirmation_selected` integer DEFAULT false NOT NULL,
	`confirmation_status` text DEFAULT 'not-required' NOT NULL,
	`assigned_user_id` text,
	`shiprocket_order_id` text,
	`shipment_id` text,
	`awb` text,
	`courier` text,
	`tracking_status` text,
	`label_key` text,
	`warehouse_acknowledged` integer DEFAULT false NOT NULL,
	`rto_eta` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`shopify_variant_id` text,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`variant` text NOT NULL,
	`image_url` text,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_sku_unique` ON `products` (`sku`);--> statement-breakpoint
CREATE TABLE `rto_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	`note` text,
	`completed_by` text,
	`completed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `webhook_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`topic` text NOT NULL,
	`received_at` text NOT NULL
);
