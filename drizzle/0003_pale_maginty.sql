CREATE TABLE `manual_sale_components` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`component_id` text NOT NULL,
	`component_sku` text NOT NULL,
	`component_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`rto_recoverable` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `manual_sales` (
	`id` text PRIMARY KEY NOT NULL,
	`reference` text NOT NULL,
	`product_id` text NOT NULL,
	`product_sku` text NOT NULL,
	`product_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`status` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manual_sales_reference_unique` ON `manual_sales` (`reference`);